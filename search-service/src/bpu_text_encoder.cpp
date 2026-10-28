#include "bpu_text_encoder.hpp"
#include "siglip_tokenizer.hpp"
#include "../../shared/cpp/bpu_reservation.hpp"
#include "../../shared/cpp/bpu_dma_buffer.hpp"
#include "../../shared/cpp/bpu_reserved_pool.hpp"
#include "../../ai-service/src/platform/bpu.hpp"
#include "../../ai-service/src/platform/bpu_image_input.hpp"
#include <cerrno>
#include <algorithm>
#include <mutex>
#include <unistd.h>

namespace ainvr::search {
namespace {
constexpr uint64_t kMinimumHeadroom = 512ULL * 1024 * 1024;
constexpr uint64_t kMaximumS100Pool = 7680ULL * 1024 * 1024;
std::string TokenizerBytes(const VerifiedPackage& package) {
  const auto relative = "tokenizers/" + package.spec->tokenizer;
  size_t length = 0;
  for (const auto& artifact : package.artifacts)
    if (artifact.relative_path == relative) {
      if (length || !artifact.bytes || artifact.bytes > 64*1024*1024)
        throw std::runtime_error("search_tokenizer_artifact_invalid");
      length = size_t(artifact.bytes);
    }
  if (!length) throw std::runtime_error("search_tokenizer_artifact_invalid");
  const int descriptor = package.BorrowedFileDescriptor(relative);
  std::string result(length, '\0'); size_t done = 0;
  while (done < result.size()) {
    const auto count = pread(descriptor, result.data() + done, result.size() - done, off_t(done));
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) throw std::runtime_error("search_tokenizer_artifact_unavailable");
    done += size_t(count);
  }
  return result;
}
[[noreturn]] void QueryError(const ainvr::text::TokenizerError& error) {
  const std::string code = error.what();
  using Reason = QueryTextError::Reason;
  if (code == "tokenizer_invalid_utf8") throw QueryTextError(Reason::InvalidUtf8);
  if (code == "tokenizer_input_too_large") throw QueryTextError(Reason::TooLarge);
  if (code == "tokenizer_query_too_long") throw QueryTextError(Reason::TooLong);
  if (code == "tokenizer_embedding_token_out_of_range") throw QueryTextError(Reason::Unrepresentable);
  throw error;
}
}  // namespace

struct BpuTextEncoder::Impl {
  // Declaration order matters: normal teardown destroys BpuModel before the
  // held package descriptors, and destroys the reservation last.
  std::unique_ptr<ainvr::BpuReservation> reservation;
  VerifiedPackage package;
  std::unique_ptr<SiglipTextTokenizer> tokenizer;
  std::unique_ptr<ainvr::BpuModel> model;
  nlohmann::json description;
  std::mutex inference;
};
BpuTextEncoder::BpuTextEncoder(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
BpuTextEncoder::~BpuTextEncoder() {
  if (impl_ && impl_->model && !ainvr::BpuRuntimeHealthy()) {
    // BpuModel first transfers unknown DMA/task storage to its existing
    // process-lifetime quarantine. Keep the REAL registry/lock custody too.
    // This custody object was allocated before submitting any BPU work, so the
    // fault path needs no allocation. The watchdog must restart the process.
    impl_->model.reset();
    (void)impl_.release();
  }
}
std::unique_ptr<BpuTextEncoder> BpuTextEncoder::Load(VerifiedPackage package,
                                                  const BpuTextLoadOptions& options) {
  const auto bytes = BpuTextReservationBytes(package);
  if (options.headroom_bytes < kMinimumHeadroom || options.total_bytes > kMaximumS100Pool ||
      options.reservation_directory.empty() || options.reservation_directory.front() != '/' ||
      options.reservation_directory.size() > 4096 ||
      options.reservation_directory.find_first_of("\r\n\0", 0, 3) != std::string::npos)
    throw std::runtime_error("invalid_search_text_resource_policy");
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  auto impl = std::make_unique<Impl>();
  impl->package = std::move(package);
  const auto actual_pool = ainvr::ReadBpuReservedPoolBytes();
  const auto total = std::min(actual_pool, options.total_bytes);
  // No BPU constructor, SDK model load, or DMA allocation may precede this.
  impl->reservation = std::make_unique<ainvr::BpuReservation>(options.reservation_directory,
      bytes, options.headroom_bytes, total, "search-service");
  if (!VerifyStillCurrent(impl->package)) throw std::runtime_error("search_model_artifact_changed");
  impl->tokenizer = std::make_unique<SiglipTextTokenizer>(TokenizerBytes(impl->package), impl->package.spec->id);
  if (!VerifyStillCurrent(impl->package)) throw std::runtime_error("search_model_artifact_changed");
  const auto path = "hbm/" + impl->package.spec->text.file;
  const int descriptor = impl->package.BorrowedFileDescriptor(path);
  // SDK reopens an internal stable descriptor, not a replaceable pathname.
  impl->model = std::make_unique<ainvr::BpuModel>("/proc/self/fd/" + std::to_string(descriptor),
                                                impl->package.spec->text.program);
  impl->description = impl->model->Describe();
  ValidateBpuTextDescription(impl->description, *impl->package.spec);
  if (!VerifyStillCurrent(impl->package)) throw std::runtime_error("search_model_artifact_changed");
  // Match Qwen's actual load-time 512MiB headroom probe. This is additional to
  // static policy, not evidence of future capacity or permission to coexist.
  { ainvr::BpuDmaBuffer headroom(options.headroom_bytes); }
  impl->reservation->Loaded();
  return std::unique_ptr<BpuTextEncoder>(new BpuTextEncoder(std::move(impl)));
}
std::string BpuTextEncoder::ModelVersion() const { return impl_->package.model_version; }
size_t BpuTextEncoder::Dimensions() const { return impl_->package.spec->dimensions; }
std::vector<float> BpuTextEncoder::Encode(const std::string& text) {
  std::unique_lock<std::mutex> lock(impl_->inference, std::try_to_lock);
  if (!lock.owns_lock()) throw std::runtime_error("search_busy");
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  SiglipTokenIds tokens;
  try { tokens = impl_->tokenizer->Encode64(text); }
  catch (const ainvr::text::TokenizerError& error) { QueryError(error); }
  const std::vector<int64_t> ids(tokens.ids.begin(), tokens.ids.end());
  auto input = ainvr::PackBpuTokenIds(ids, impl_->description.at("inputs").at(0),
                                     impl_->package.spec->embedding_vocab_size);
  const auto outputs = impl_->model->Run({std::move(input)});
  if (outputs.size() != 1) throw std::runtime_error("search_text_output_invalid");
  return DecodeBpuTextEmbedding(outputs.front(), impl_->description.at("outputs").at(0), *impl_->package.spec);
}
}  // namespace ainvr::search

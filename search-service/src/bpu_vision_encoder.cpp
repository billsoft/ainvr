#include "bpu_vision_encoder.hpp"
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../shared/cpp/bpu_dma_buffer.hpp"
#include "../../shared/cpp/bpu_reserved_pool.hpp"
#include "../../ai-service/src/platform/bpu_image_runner.hpp"
#include <algorithm>
#include <mutex>
#include <thread>
namespace ainvr::search {
struct BpuVisionEncoder::Impl {
  // Reverse destruction: runner(model/GLES) -> held FD package -> reservation.
  std::unique_ptr<ainvr::BpuCoexistReservation> reservation;
  VerifiedPackage package;
  std::unique_ptr<ainvr::BpuImageRunner> runner;
  const std::thread::id owner = std::this_thread::get_id();
  std::mutex inference;
};
BpuVisionEncoder::BpuVisionEncoder(std::unique_ptr<Impl> impl): impl_(std::move(impl)) {}
BpuVisionEncoder::~BpuVisionEncoder() {
  if (!impl_) return;
  if (impl_->owner != std::this_thread::get_id()) {
    // Releasing a GLES context on a foreign thread is unsafe. Preserve actual
    // model/FD/reservation custody until process exit; owner teardown is a bug.
    (void)impl_.release();
  } else if (impl_->runner && !ainvr::BpuRuntimeHealthy()) {
    impl_->runner.reset(); // BpuModel transfers unknown task/DMA to quarantine.
    (void)impl_.release(); // Keep real reservation and held FDs for watchdog.
  }
}
std::unique_ptr<BpuVisionEncoder> BpuVisionEncoder::Load(VerifiedPackage package, const BpuVisionLoadOptions& options) {
  ValidateBpuVisionLoadOptions(options);
  const auto bytes = BpuVisionReservationBytes(package);
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  auto impl = std::make_unique<Impl>(); impl->package = std::move(package);
  ainvr::IonPolicy policy; policy.pool_bytes = std::min(ainvr::ReadBpuIonBudgetBytes(),options.total_bytes);
  policy.min_free = options.headroom_bytes;
  // Must precede BpuImageRunner, BpuModel, SDK and DMA allocations.
  impl->reservation = std::make_unique<ainvr::BpuCoexistReservation>(options.reservation_directory,"search-service",bytes,policy);
  if (!VerifyStillCurrent(impl->package)) throw std::runtime_error("search_model_artifact_changed");
  const int fd = impl->package.BorrowedFileDescriptor("hbm/" + impl->package.spec->vision.file);
  impl->runner = std::make_unique<ainvr::BpuImageRunner>("/proc/self/fd/" + std::to_string(fd),
    ainvr::BpuImageContract::FloatNchw,impl->package.spec->vision.input.name,impl->package.spec->vision.program);
  ValidateBpuVisionDescription(impl->runner->Description(),*impl->package.spec);
  if (!VerifyStillCurrent(impl->package)) throw std::runtime_error("search_model_artifact_changed");
  { ainvr::BpuDmaBuffer headroom(options.headroom_bytes); }
  impl->reservation->Loaded();
  return std::unique_ptr<BpuVisionEncoder>(new BpuVisionEncoder(std::move(impl)));
}
const std::string& BpuVisionEncoder::ModelVersion() const { return impl_->package.model_version; }
const std::string& BpuVisionEncoder::InputSpecVersion() const { return impl_->package.spec->input_spec_version; }
size_t BpuVisionEncoder::Dimensions() const { return impl_->package.spec->dimensions; }
BpuVisionResult BpuVisionEncoder::Encode(const ainvr::Nv12Frame& frame, const ainvr::SnapshotPlan& plan, bool bt709, bool full_range) {
  if (impl_->owner != std::this_thread::get_id()) throw std::runtime_error("search_vision_owner_thread_mismatch");
  std::unique_lock<std::mutex> lock(impl_->inference,std::try_to_lock);
  if (!lock.owns_lock()) throw std::runtime_error("search_busy");
  if (!ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_bpu_runtime_fault");
  const auto transform = BpuVisionTransform(plan,*impl_->package.spec,bt709,full_range);
  const auto output = impl_->runner->Run(frame,transform);
  if (output.image_backend != "gles") throw std::runtime_error("search_vision_preprocessing_contract_changed");
  return {NormalizeBpuVisionEmbedding(output.outputs,*impl_->package.spec),output.image_backend,
    output.preprocess_ms,output.inference_ms,output.output_decode_ms};
}
}  // namespace ainvr::search

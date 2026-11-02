#include "output/search_hardware_qwen.hpp"
#include "output/search_hardware_plan.hpp"
#include "output/search_qwen_runtime.hpp"
#include "output/search_qwen_transform.hpp"
#include "output/snapshot_renderer.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include <algorithm>
#include "platform/bpu.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/vpu_decoder.hpp"
#include "../../../shared/cpp/embed_ipc.hpp"

namespace ai_service::output {
namespace {

// Sampling side of the Qwen3-VL-Embedding model: thread-affine GLES/JPU image work around the shared weights.
class QwenSession final : public SearchHardwareSession {
 public:
  QwenSession(const std::string& package, SearchHardwareNativeOptions options,
              const std::optional<ainvr::search::RuntimeModelPin>& expected, const SearchSamplingCurrent& current)
      : options_(options), renderer_({}, ainvr::SnapshotEncodingPolicy::HardwareOnly), preprocessor_({true, true, false}) {
    if (options.jpeg_quality < 1 || options.jpeg_quality > 100) throw std::invalid_argument("search_hardware_quality_invalid");
    SearchHardwarePlan({0, 0, 20, 20}, 20, 20, false, options.object_max_dimension, options.object_padding_ratio);
    SearchHardwarePlan({}, 20, 20, true, options.scene_max_dimension, 0);
    if (!current || !current()) throw std::runtime_error("search_hardware_stale");
    // Shared with the text-query channel: the weights are loaded once whoever asks first.
    runtime_ = QwenEmbeddingHost::Instance().Acquire(package, expected, current);
    if (!current()) throw std::runtime_error("search_hardware_stale");
    space_ = runtime_->Space();
  }
  SearchEmbeddingSpace Space() const override { return space_; }
  std::function<bool()> HealthReader() const override { return [] { return ainvr::BpuRuntimeHealthy(); }; }
  SearchHardwareProduct Prepare(const FrozenSearchFrame& frame, const SearchSamplingCurrent& current) override {
    if (!current || !current() || !ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_hardware_stale");
    const bool scene = !frame.Selection().slot;
    if (!scene && !frame.RawTargetBox()) throw std::runtime_error("search_hardware_target_missing");
    const auto& raw = frame.Pixels();
    auto plan = SearchHardwarePlan(scene ? std::array<double, 4>{} : *frame.RawTargetBox(), raw.width, raw.height, scene,
                                   scene ? options_.scene_max_dimension : options_.object_max_dimension, options_.object_padding_ratio);
    auto image = renderer_.RenderPlanned(raw, plan, options_.jpeg_quality, frame.Bt709(), frame.FullRange());
    if (!current()) throw std::runtime_error("search_hardware_stale");
    auto vector = Embed(raw, plan, frame.Bt709(), frame.FullRange(), current, &backend_);
    return {image.plan, std::move(image.jpeg), std::move(vector), image.render_backend, image.encoder_backend, backend_};
  }
  // Historical-image path (model migration and the hardware probe): JPU decode -> the same GPU resize -> the same embedder.
  SearchReencodeResult ReencodeJpeg(const std::vector<uint8_t>& jpeg, const SearchSamplingCurrent& current) override {
    auto check = [&] { if (!current || !current() || !ainvr::BpuRuntimeHealthy()) throw std::runtime_error("search_hardware_stale"); };
    check();
    const auto [width, height] = analytics::JpegDimensions(jpeg);
    if (jpeg.size() > kSearchReencodeMaxJpegBytes || width < 16 || height < 16 || width % 2 || height % 2 ||
        size_t(width) * size_t(height) > kSearchReencodeMaxPixels)
      return {SearchReencodeResult::Status::Unsupported, {}, {}, 0, 0};
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg, width, height);
    while (!decoder.Submit(jpeg, 0, 50)) check();
    std::optional<ainvr::Nv12Frame> frame;
    while (!frame) { check(); frame = decoder.Receive(50); }
    check();
    if (frame->width != width || frame->height != height || frame->pixels.size() != size_t(width) * height * 3 / 2)
      throw std::runtime_error("search_reencode_decoded_dimensions_invalid");
    // Same full-source plan and colour contract as the SigLIP session (JPU output: full-range BT.601).
    auto plan = SearchHardwarePlan({}, width, height, true, std::min(4096, std::max(width, height)), 0);
    std::string backend;
    auto vector = Embed(*frame, plan, false, true, current, &backend);
    return {SearchReencodeResult::Status::Ready, space_, std::move(vector), width, height};
  }

 private:
  std::vector<float> Embed(const ainvr::Nv12Frame& frame, const ainvr::SnapshotPlan& plan, bool bt709, bool full_range,
                           const SearchSamplingCurrent& current, std::string* backend) {
    auto prepared = preprocessor_.RunNv12(frame, QwenVisionTransform(plan, bt709, full_range));
    if (prepared.backend.find("gles") == std::string::npos || prepared.backend.find("cpu") != std::string::npos)
      throw std::runtime_error("search_vision_preprocessing_contract_changed");
    if (prepared.chw.size() != size_t(3) * kQwenImageWidth * kQwenImageHeight) throw std::runtime_error("search_vision_output_invalid");
    if (!current()) throw std::runtime_error("search_hardware_stale");
    *backend = prepared.backend;
    auto vector = runtime_->Embedder().EmbedImageChw(prepared.chw.data());
    if (!current()) throw std::runtime_error("search_hardware_stale");
    return vector;
  }

  SearchHardwareNativeOptions options_;
  ainvr::SnapshotRenderer renderer_;
  ainvr::ImagePreprocessor preprocessor_;
  SearchEmbeddingSpace space_;
  std::string backend_;
  std::shared_ptr<QwenEmbeddingRuntime> runtime_;
};
}  // namespace

std::unique_ptr<SearchHardwareSession> MakeQwenSearchSession(const std::string& package_id,
    const SearchHardwareNativeOptions& options, const std::optional<ainvr::search::RuntimeModelPin>& expected,
    const SearchSamplingCurrent& current) {
  return std::make_unique<QwenSession>(package_id, options, expected, current);
}

}  // namespace ai_service::output

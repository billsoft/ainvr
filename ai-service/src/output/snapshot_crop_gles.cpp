#include "snapshot_internal.hpp"
#include "platform/gles_crop.hpp"
#include <exception>

namespace ai_service::output {
using namespace snapshot_detail;
// Original scalar crop planning, with only pixel execution replaced by GLES.
namespace {
struct OrdinaryPlan { cv::Rect region; cv::Size output; bool huge = false; };
std::optional<OrdinaryPlan> PlanOrdinary(cv::Size frame_size,const std::array<double,4>& bbox,
                                       double padding_ratio,int max_dimension,bool keep_square) {
  double x = bbox[0], y = bbox[1], w = bbox[2], h = bbox[3];
  if (w <= 0.0 || h <= 0.0) return {};

  int frame_h = frame_size.height, frame_w = frame_size.width;

  if (keep_square) {
    double cx = x + w / 2.0, cy = y + h / 2.0;
    double side = std::max(w, h) * (1.0 + 2.0 * padding_ratio);
    int side_px = std::max(1, static_cast<int>(PyRound(side)));
    int x1 = static_cast<int>(PyRound(cx - side / 2.0));
    int y1 = static_cast<int>(PyRound(cy - side / 2.0));

    int sx1 = std::max(0, x1), sy1 = std::max(0, y1);
    int sx2 = std::min(frame_w, x1 + side_px), sy2 = std::min(frame_h, y1 + side_px);
    if (sx2 <= sx1 || sy2 <= sy1) return {};

    const int out=std::min(side_px,max_dimension);
    const bool huge=size_t(side_px)*side_px*4>(size_t(256)<<20);
    return OrdinaryPlan{{x1,y1,side_px,side_px},{out,out},huge};
  }

  double pad_x = w * padding_ratio, pad_y = h * padding_ratio;
  double x1 = std::max(0.0, x - pad_x), y1 = std::max(0.0, y - pad_y);
  double x2 = std::min(static_cast<double>(frame_w), x + w + pad_x);
  double y2 = std::min(static_cast<double>(frame_h), y + h + pad_y);

  int x1i = static_cast<int>(std::floor(x1)), y1i = static_cast<int>(std::floor(y1));
  int x2i = static_cast<int>(std::ceil(x2)), y2i = static_cast<int>(std::ceil(y2));
  if (x2i <= x1i || y2i <= y1i) return {};

  const cv::Rect region(x1i,y1i,x2i-x1i,y2i-y1i);
  cv::Size output=region.size();
  int longest = std::max(output.height, output.width);
  if (longest > max_dimension) {
    double scale = static_cast<double>(max_dimension) / longest;
    int new_w = std::max(1, static_cast<int>(PyRound(output.width * scale)));
    int new_h = std::max(1, static_cast<int>(PyRound(output.height * scale)));
    output={new_w,new_h};
  }
  return OrdinaryPlan{region,output,false};
}
cv::Mat CropUploaded(ainvr::GlesCropBackend& gpu,cv::Size frame_size,const std::array<double,4>& bbox,
                     double padding_ratio,int max_dimension,bool keep_square) {
  auto plan=PlanOrdinary(frame_size,bbox,padding_ratio,max_dimension,keep_square);
  return plan ? gpu.Area(plan->region,plan->output,plan->huge) : cv::Mat{};
}
}
cv::Mat CropWithPadding(const cv::Mat& frame_rgba,const std::array<double,4>& bbox,
                        double padding_ratio,int max_dimension,bool keep_square){
  if(max_dimension<=0||!std::isfinite(padding_ratio)||padding_ratio<0||padding_ratio>1||
     !std::all_of(bbox.begin(),bbox.end(),[](double v){return std::isfinite(v)&&std::abs(v)<=32760;}))
    throw std::invalid_argument("Invalid hardware snapshot crop parameters");
  if(bbox[2]<=0||bbox[3]<=0)return {};
  static thread_local std::unique_ptr<ainvr::GlesCropBackend> gpu;
  try{if(!gpu)gpu=std::make_unique<ainvr::GlesCropBackend>();gpu->Upload(frame_rgba);
    return CropUploaded(*gpu,frame_rgba.size(),bbox,padding_ratio,max_dimension,keep_square);
  }catch(...){gpu.reset();throw;}
}

std::vector<cv::Mat> SnapshotCropper::Crop(
    const pipeline::SnapshotSink::FrameProvider& frame,
    const std::vector<Detection>& detections, bool square,
    const config::SnapshotConfig& cfg) {
  downloaded_bytes_ = 0;
  download_ms_ = 0;
  full_frame_ = false;
  invalid_count_ = 0;
  const cv::Rect bounds({}, frame.size);
  constexpr size_t kFrameBudget = size_t(256) << 20;
  constexpr size_t kPlanBudget = size_t(32) << 20;
  constexpr size_t kOutputBudget = size_t(128) << 20;
  if (frame.size.width <= 0 || frame.size.height <= 0 ||
      frame.size.width >= 32767 || frame.size.height >= 32767 ||
      size_t(frame.size.width) * frame.size.height * 4 > kFrameBudget ||
      detections.size() > 64 || cfg.max_crop_dimension <= 0 ||
      !std::isfinite(cfg.padding_ratio) ||
      cfg.padding_ratio < 0 || cfg.padding_ratio > 1 || !frame.download) {
    throw std::invalid_argument("snapshot crop exceeds image/config budget");
  }
  struct Plan {
    bool valid = false;
    ErpView view;
    std::shared_ptr<const ainvr::GlesErpMap> map;
    std::optional<OrdinaryPlan> ordinary;
  };
  std::vector<Plan> plans(detections.size());
  std::vector<cv::Mat> result(detections.size());
  const bool erp = cfg.projection_mode == "erp_equirect";
  cv::Rect region;
  size_t plan_bytes = 0, output_bytes = 0;
  bool fallback = false;
  for (size_t i = 0; i < detections.size(); ++i) {
    const auto& b = detections[i].bbox;
    if (!std::all_of(b.begin(), b.end(), [](double v) {
          return std::isfinite(v) && std::abs(v) <= 32760;
        }) || b[2] <= 0 || b[3] <= 0) { ++invalid_count_; continue; }
    auto& p = plans[i];
    if (!erp) {
      p.ordinary=PlanOrdinary(frame.size,b,cfg.padding_ratio,cfg.max_crop_dimension,square);
      if (!p.ordinary) { ++invalid_count_; continue; }
      double side = std::max(b[2], b[3]) * (1 + 2 * cfg.padding_ratio);
      double out_w = square ? std::max(1.0, PyRound(side)) :
          std::min(double(frame.size.width), b[2] * (1 + 2 * cfg.padding_ratio) + 2);
      double out_h = square ? out_w :
          std::min(double(frame.size.height), b[3] * (1 + 2 * cfg.padding_ratio) + 2);
      double scale = std::min(1.0, cfg.max_crop_dimension / std::max(out_w, out_h));
      const size_t bytes = size_t(std::ceil(out_w * scale)) * size_t(std::ceil(out_h * scale)) * 4;
      if (output_bytes + bytes > kOutputBudget) throw CropBatchBudgetError("crop batch exceeds output budget; split batch");
      output_bytes += bytes;
      p.valid = true;
      const auto required=p.ordinary->region & bounds;
      region=region.empty() ? required : region | required;
      continue;
    }
    auto view = BboxToErpView(b, cfg.padding_ratio, frame.size.width, frame.size.height,
                             cfg.max_crop_dimension, 9, square);
    if (!view) { ++invalid_count_; continue; }
    const size_t bytes = size_t(view->w_out) * view->h_out * 4;
    if (output_bytes + bytes > kOutputBudget) throw CropBatchBudgetError("crop batch exceeds output budget; split batch");
    auto ss = ScaleErpView(*view, kErpSupersampleFactor);
    const size_t map_bytes = size_t(ss.w_out) * ss.h_out * 8;
    if (map_bytes > kPlanBudget) throw std::invalid_argument("unsupported crop size; maximum is 1280");
    output_bytes += bytes;
    p.valid = true;
    p.view = *view;
    plan_bytes += map_bytes;
    if (plan_bytes > kPlanBudget) fallback = true;
  }
  // Decide fallback before touching the quantized LRU. Each target accesses its
  // mapping once, in the same order as the original algorithm, even after eviction.
  if (std::none_of(plans.begin(),plans.end(),[](const Plan& p){return p.valid;})) return result;
  if (!gpu_) gpu_=std::make_shared<ainvr::GlesCropBackend>();
  // Any exceptional GPU operation discards cached device state for a clean
  // retry by the original archive worker. No CPU execution is selected.
  struct RetryState { std::shared_ptr<ainvr::GlesCropBackend>& gpu; int exceptions=std::uncaught_exceptions();
    ~RetryState(){if(std::uncaught_exceptions()>exceptions)gpu.reset();}
  } retry{gpu_};
  if (erp && !fallback) for (auto& p : plans) {
    if (!p.valid) continue;
    auto ss = ScaleErpView(p.view, kErpSupersampleFactor);
    p.map=gpu_->GetMap(frame.size,ss);
    if (!p.map->finite) {
      p.valid = false;
      ++invalid_count_;
      continue;
    }
    cv::Rect required=p.map->required;
    region = region.empty() ? required : region | required;
  }
  if (std::none_of(plans.begin(), plans.end(), [](const Plan& p) { return p.valid; })) return result;
  if (fallback || region.empty()) region = bounds;
  full_frame_ = region == bounds;
  // Discard retained map references before sequential fallback to enforce the budget.
  if (fallback) for (auto& p : plans) p.map.reset();
  double start = NowMono();
  frame.download(region, host_);
  download_ms_ = (NowMono() - start) * 1000;
  if (host_.size() != region.size() || host_.type() != CV_8UC4)
    throw std::runtime_error("snapshot provider returned invalid region");
  downloaded_bytes_ = host_.total() * host_.elemSize();
  gpu_->Upload(host_);
  for (size_t i = 0; i < plans.size(); ++i) {
    auto& p = plans[i];
    if (!p.valid) continue;
    if (!erp) {
      // Round in global coordinates before subtracting the integer ROI origin.
      // Re-rounding shifted fractional boxes would change banker's-round ties.
      auto local=p.ordinary->region; local.x-=region.x; local.y-=region.y;
      result[i] = gpu_->Area(local,p.ordinary->output,p.ordinary->huge);
      if (result[i].empty()) ++invalid_count_;
      continue;
    }
    if (!p.map) {
      auto ss = ScaleErpView(p.view, kErpSupersampleFactor);
      p.map=gpu_->GetMap(frame.size,ss);
    }
    result[i]=gpu_->Remap(p.map,region.tl(),{p.view.w_out,p.view.h_out});
    if (fallback) p.map.reset();
  }
  return result;
}

// ---- 幂等 trim ----


}  // namespace ai_service::output

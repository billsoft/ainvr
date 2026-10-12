#include "snapshot_internal.hpp"

namespace ai_service::output {
using namespace snapshot_detail;
// ---- 纯函数:裁剪 ----

cv::Mat CropWithPadding(const cv::Mat& frame_rgba, const std::array<double, 4>& bbox,
                        double padding_ratio, int max_dimension, bool keep_square) {
  double x = bbox[0], y = bbox[1], w = bbox[2], h = bbox[3];
  if (w <= 0.0 || h <= 0.0) return {};

  int frame_h = frame_rgba.rows, frame_w = frame_rgba.cols;

  if (keep_square) {
    double cx = x + w / 2.0, cy = y + h / 2.0;
    double side = std::max(w, h) * (1.0 + 2.0 * padding_ratio);
    int side_px = std::max(1, static_cast<int>(PyRound(side)));
    int x1 = static_cast<int>(PyRound(cx - side / 2.0));
    int y1 = static_cast<int>(PyRound(cy - side / 2.0));

    int sx1 = std::max(0, x1), sy1 = std::max(0, y1);
    int sx2 = std::min(frame_w, x1 + side_px), sy2 = std::min(frame_h, y1 + side_px);
    if (sx2 <= sx1 || sy2 <= sy1) return {};

    // Huge padded squares must not allocate the padded source at full size.
    // Map directly into the bounded output, preserving edge replication.
    if (size_t(side_px) * side_px * 4 > (size_t(256) << 20)) {
      const int out = std::min(side_px, max_dimension);
      cv::Mat mx(out, out, CV_32F), my(out, out, CV_32F), crop;
      const double scale = double(side_px) / out;
      for (int row = 0; row < out; ++row) for (int col = 0; col < out; ++col) {
        mx.at<float>(row, col) = float(x1 + (col + 0.5) * scale - 0.5);
        my.at<float>(row, col) = float(y1 + (row + 0.5) * scale - 0.5);
      }
      cv::remap(frame_rgba, crop, mx, my, cv::INTER_LINEAR, cv::BORDER_REPLICATE);
      return crop;
    }

    cv::Mat src = frame_rgba(cv::Rect(sx1, sy1, sx2 - sx1, sy2 - sy1)).clone();
    int left = sx1 - x1, top = sy1 - y1;
    int right = side_px - (sx2 - x1), bottom = side_px - (sy2 - y1);
    if (left || top || right || bottom) {
      cv::copyMakeBorder(src, src, std::max(0, top), std::max(0, bottom), std::max(0, left),
                          std::max(0, right), cv::BORDER_REPLICATE);
    }
    cv::Mat crop = src;
    if (side_px > max_dimension) {
      cv::resize(crop, crop, cv::Size(max_dimension, max_dimension), 0, 0, cv::INTER_AREA);
    }
    return crop;
  }

  double pad_x = w * padding_ratio, pad_y = h * padding_ratio;
  double x1 = std::max(0.0, x - pad_x), y1 = std::max(0.0, y - pad_y);
  double x2 = std::min(static_cast<double>(frame_w), x + w + pad_x);
  double y2 = std::min(static_cast<double>(frame_h), y + h + pad_y);

  int x1i = static_cast<int>(std::floor(x1)), y1i = static_cast<int>(std::floor(y1));
  int x2i = static_cast<int>(std::ceil(x2)), y2i = static_cast<int>(std::ceil(y2));
  if (x2i <= x1i || y2i <= y1i) return {};

  cv::Mat crop = frame_rgba(cv::Rect(x1i, y1i, x2i - x1i, y2i - y1i)).clone();
  int longest = std::max(crop.rows, crop.cols);
  if (longest > max_dimension) {
    double scale = static_cast<double>(max_dimension) / longest;
    int new_w = std::max(1, static_cast<int>(PyRound(crop.cols * scale)));
    int new_h = std::max(1, static_cast<int>(PyRound(crop.rows * scale)));
    cv::resize(crop, crop, cv::Size(new_w, new_h), 0, 0, cv::INTER_AREA);
  }
  return crop;
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
    cv::Mat x, y;
  };
  std::vector<Plan> plans(detections.size());
  std::vector<cv::Mat> result(detections.size());
  const bool erp = cfg.projection_mode == "erp_equirect";
  cv::Rect region;
  size_t plan_bytes = 0, output_bytes = 0;
  bool fallback = !erp;
  for (size_t i = 0; i < detections.size(); ++i) {
    const auto& b = detections[i].bbox;
    if (!std::all_of(b.begin(), b.end(), [](double v) {
          return std::isfinite(v) && std::abs(v) <= 32760;
        }) || b[2] <= 0 || b[3] <= 0) { ++invalid_count_; continue; }
    auto& p = plans[i];
    if (!erp) {
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
  if (!fallback) for (auto& p : plans) {
    if (!p.valid) continue;
    auto ss = ScaleErpView(p.view, kErpSupersampleFactor);
    auto [mx, my] = maps_.GetOrBuild(frame.size.width, frame.size.height, ss);
    if (!cv::checkRange(mx) || !cv::checkRange(my)) {
      p.valid = false;
      ++invalid_count_;
      continue;
    }
    double x0, x1, y0, y1;
    cv::minMaxLoc(mx, &x0, &x1);
    cv::minMaxLoc(my, &y0, &y1);
    // cubic uses floor(coord)+[-1,2]; include an additional pixel for rounding.
    int left = int(std::clamp(std::floor(x0) - 2, 0.0, double(frame.size.width - 1)));
    int top = int(std::clamp(std::floor(y0) - 2, 0.0, double(frame.size.height - 1)));
    int right = int(std::clamp(std::ceil(x1) + 3, double(left + 1), double(frame.size.width)));
    int bottom = int(std::clamp(std::ceil(y1) + 3, double(top + 1), double(frame.size.height)));
    cv::Rect required(left, top, right - left, bottom - top);
    region = region.empty() ? required : region | required;
    p.x = mx;
    p.y = my;
  }
  if (std::none_of(plans.begin(), plans.end(), [](const Plan& p) { return p.valid; })) return result;
  if (fallback || region.empty()) region = bounds;
  full_frame_ = region == bounds;
  // Discard retained map references before sequential fallback to enforce the budget.
  if (fallback) for (auto& p : plans) { p.x.release(); p.y.release(); }
  double start = NowMono();
  frame.download(region, host_);
  download_ms_ = (NowMono() - start) * 1000;
  if (host_.size() != region.size() || host_.type() != CV_8UC4)
    throw std::runtime_error("snapshot provider returned invalid region");
  downloaded_bytes_ = host_.total() * host_.elemSize();
  for (size_t i = 0; i < plans.size(); ++i) {
    auto& p = plans[i];
    if (!p.valid) continue;
    if (!erp) {
      result[i] = CropWithPadding(host_, detections[i].bbox, cfg.padding_ratio,
                                  cfg.max_crop_dimension, square);
      if (result[i].empty()) ++invalid_count_;
      continue;
    }
    if (p.x.empty()) {
      auto ss = ScaleErpView(p.view, kErpSupersampleFactor);
      std::tie(p.x, p.y) = maps_.GetOrBuild(frame.size.width, frame.size.height, ss);
    }
    cv::Mat sample;
    if (full_frame_) {
      sample = SampleErpPerspective(host_, p.x, p.y);
    } else {
      // Quantize in original coordinates exactly as the old CPU remap does.
      // Subtracting float coordinates first can change interpolation rounding.
      cv::Mat integer_map, fractions;
      cv::convertMaps(p.x, p.y, integer_map, fractions, CV_16SC2);
      integer_map -= cv::Scalar(region.x, region.y);
      cv::remap(host_, sample, integer_map, fractions, cv::INTER_CUBIC, cv::BORDER_REPLICATE);
    }
    cv::resize(sample, result[i], cv::Size(p.view.w_out, p.view.h_out), 0, 0, cv::INTER_CUBIC);
    if (fallback) { p.x.release(); p.y.release(); }
  }
  return result;
}

// ---- 幂等 trim ----


}  // namespace ai_service::output

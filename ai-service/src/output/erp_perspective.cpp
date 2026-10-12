#include "erp_perspective.hpp"

#include <algorithm>
#include <cmath>
#include <vector>
#include <stdexcept>

#include <opencv2/imgproc.hpp>

namespace ai_service::output {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Python 内置 round() 对浮点数用 round-half-to-even(银行家舍入),不是
// std::lround 的"四舍五入远离零"——.5 边界两者会差 1(实测踩过:
// bbox_to_erp_view 的 w_out/h_out 计算密集触发 .5 边界,off-by-one 曾在
// golden fixture 对照里暴露出来)。std::nearbyint 在默认浮点环境
// (FE_TONEAREST)下正是 round-half-to-even,与 Python round() 语义一致,
// 本文件所有对外可见的尺寸/量化计算都要用这个,不能用 std::lround。
double PyRound(double x) { return std::nearbyint(x); }

cv::Vec3d ErpPixelToWorldDir(double px, double py, int erp_w, int erp_h) {
  double lam = (px / erp_w - 0.5) * 2.0 * kPi;
  double phi = (0.5 - py / erp_h) * kPi;
  return cv::Vec3d(std::cos(phi) * std::sin(lam), std::sin(phi), std::cos(phi) * std::cos(lam));
}

cv::Matx33d RotationMatrix(double yaw, double pitch) {
  double cos_yaw = std::cos(yaw), sin_yaw = std::sin(yaw);
  double cos_pitch = std::cos(-pitch), sin_pitch = std::sin(-pitch);
  cv::Matx33d rot_y(cos_yaw, 0, sin_yaw, 0, 1, 0, -sin_yaw, 0, cos_yaw);
  cv::Matx33d rot_x(1, 0, 0, 0, cos_pitch, -sin_pitch, 0, sin_pitch, cos_pitch);
  return rot_y * rot_x;
}

// 世界方向 -> 取景相机切平面坐标(x_cam,y_cam)。方向落在取景相机身后
// (local[2]<=0)时返回 nullopt。
std::optional<std::pair<double, double>> WorldDirToCamspace(const cv::Vec3d& world_dir,
                                                              const cv::Matx33d& R) {
  cv::Vec3d local = R.t() * world_dir;  // R 是旋转矩阵,R^-1=R^T
  if (local[2] <= 1e-9) return std::nullopt;
  return std::make_pair(local[0] / local[2], -local[1] / local[2]);
}

std::vector<std::pair<double, double>> SampleBboxBoundaryCamspace(
    const std::array<double, 4>& bbox, int erp_w, int erp_h, double yaw, double pitch,
    int samples_per_edge) {
  double x = bbox[0], y = bbox[1], w = bbox[2], h = bbox[3];
  cv::Matx33d R = RotationMatrix(yaw, pitch);
  std::vector<std::pair<double, double>> out;
  auto try_point = [&](double px, double py) {
    auto proj = WorldDirToCamspace(ErpPixelToWorldDir(px, py, erp_w, erp_h), R);
    if (proj.has_value()) out.push_back(*proj);
  };
  for (int i = 0; i < samples_per_edge; ++i) {
    double t = samples_per_edge > 1 ? static_cast<double>(i) / (samples_per_edge - 1) : 0.0;
    try_point(x + t * w, y);
    try_point(x + t * w, y + h);
    try_point(x, y + t * h);
    try_point(x + w, y + t * h);
  }
  return out;
}

ErpView LinearFallback(double cx, double cy, double w, double h, double padding_ratio, int erp_w,
                        int max_dimension, bool square) {
  double padded_w = w * (1.0 + 2.0 * padding_ratio);
  double padded_h = h * (1.0 + 2.0 * padding_ratio);
  if (square) padded_w = padded_h = std::max(padded_w, padded_h);
  double fov_h_deg =
      std::clamp((padded_w / erp_w) * 360.0, kMinFovDeg, kMaxFovDeg);
  double longest = std::max(padded_w, padded_h);
  if (longest > max_dimension) {
    double scale = max_dimension / longest;
    padded_w *= scale;
    padded_h *= scale;
  }
  ErpView v;
  v.cx = cx;
  v.cy = cy;
  v.fov_h_deg = fov_h_deg;
  v.w_out = std::max(1, static_cast<int>(PyRound(padded_w)));
  v.h_out = std::max(1, static_cast<int>(PyRound(padded_h)));
  return v;
}

}  // namespace

std::optional<ErpView> BboxToErpView(const std::array<double, 4>& bbox, double padding_ratio,
                                      int erp_w, int erp_h, int max_dimension,
                                      int samples_per_edge, bool square) {
  double x = bbox[0], y = bbox[1], w = bbox[2], h = bbox[3];
  if (w <= 0.0 || h <= 0.0) return std::nullopt;

  double cx = x + w / 2.0;
  double cy = y + h / 2.0;
  double yaw = (cx / erp_w - 0.5) * 2.0 * kPi;
  double pitch = (0.5 - cy / erp_h) * kPi;

  auto points = SampleBboxBoundaryCamspace(bbox, erp_w, erp_h, yaw, pitch, samples_per_edge);
  if (points.size() < 4) {
    return LinearFallback(cx, cy, w, h, padding_ratio, erp_w, max_dimension, square);
  }

  double tight_half_x = 0.0, tight_half_y = 0.0;
  for (auto&& [px, py] : points) {
    tight_half_x = std::max(tight_half_x, std::fabs(px));
    tight_half_y = std::max(tight_half_y, std::fabs(py));
  }
  if (tight_half_x <= 1e-12 || tight_half_y <= 1e-12) {
    return LinearFallback(cx, cy, w, h, padding_ratio, erp_w, max_dimension, square);
  }

  double margin_scale = 1.0 + 2.0 * padding_ratio;
  double margin_half_x = tight_half_x * margin_scale;
  double margin_half_y = tight_half_y * margin_scale;

  if (square) {
    double m = std::max(margin_half_x, margin_half_y);
    margin_half_x = margin_half_y = m;
  }

  double fov_h_deg =
      std::clamp((2.0 * std::atan(margin_half_x)) * 180.0 / kPi, kMinFovDeg, kMaxFovDeg);

  double kx = w / (2.0 * tight_half_x);
  double ky = h / (2.0 * tight_half_y);
  double k = std::min(kx, ky);
  double padded_w = 2.0 * margin_half_x * k;
  double padded_h = 2.0 * margin_half_y * k;

  double shortest = std::min(padded_w, padded_h);
  if (shortest < kSafetyMinOutputPx) {
    double scale = kSafetyMinOutputPx / shortest;
    padded_w *= scale;
    padded_h *= scale;
  }

  double longest = std::max(padded_w, padded_h);
  if (longest > max_dimension) {
    double scale = max_dimension / longest;
    padded_w *= scale;
    padded_h *= scale;
  }

  ErpView v;
  v.cx = cx;
  v.cy = cy;
  v.fov_h_deg = fov_h_deg;
  v.w_out = std::max(1, static_cast<int>(PyRound(padded_w)));
  v.h_out = std::max(1, static_cast<int>(PyRound(padded_h)));
  return v;
}

ErpView ScaleErpView(const ErpView& view, double factor) {
  int w_scaled = std::max(1, static_cast<int>(PyRound(view.w_out * factor)));
  double aspect = static_cast<double>(view.w_out) / view.h_out;
  int h_scaled = std::max(1, static_cast<int>(PyRound(w_scaled / aspect)));
  ErpView out;
  out.cx = view.cx;
  out.cy = view.cy;
  out.fov_h_deg = view.fov_h_deg;
  out.w_out = w_scaled;
  out.h_out = h_scaled;
  return out;
}

std::pair<cv::Mat, cv::Mat> BuildErpMap(int erp_w, int erp_h, double cx, double cy,
                                         double fov_h_deg, int w_out, int h_out) {
#ifdef AINVR_ERP_METADATA_ONLY
  throw std::runtime_error("CPU ERP map generation is a test oracle only");
#else
  double yaw = (cx / erp_w - 0.5) * 2.0 * kPi;
  double pitch = (0.5 - cy / erp_h) * kPi;

  double fov_h = fov_h_deg * kPi / 180.0;
  double aspect = static_cast<double>(w_out) / h_out;
  double fov_v = 2.0 * std::atan(std::tan(fov_h / 2.0) / aspect);
  double fx = (w_out / 2.0) / std::tan(fov_h / 2.0);
  double fy = (h_out / 2.0) / std::tan(fov_v / 2.0);

  cv::Matx33d R = RotationMatrix(yaw, pitch);

  cv::Mat map_x(h_out, w_out, CV_32FC1);
  cv::Mat map_y(h_out, w_out, CV_32FC1);

  auto fill_rows = [&](const cv::Range& rows) {
    for (int v = rows.start; v < rows.end; ++v) {
      float* mx_row = map_x.ptr<float>(v);
      float* my_row = map_y.ptr<float>(v);
      for (int u = 0; u < w_out; ++u) {
        double x_cam = (u - w_out / 2.0) / fx;
        double y_cam = (v - h_out / 2.0) / fy;
        cv::Vec3d dir(x_cam, -y_cam, 1.0);
        double norm = std::sqrt(dir.dot(dir));
        dir *= (1.0 / norm);

        cv::Vec3d world = R * dir;
        double X = world[0], Y = world[1], Z = world[2];
        double lam = std::atan2(X, Z);
        double phi = std::asin(std::clamp(Y, -1.0, 1.0));

        double x_erp = (lam / (2.0 * kPi) + 0.5) * erp_w;
        double y_erp = (0.5 - phi / kPi) * erp_h;

        x_erp = std::fmod(x_erp, static_cast<double>(erp_w));
        if (x_erp < 0) x_erp += erp_w;  // C++ fmod 可能是负数,Python % 恒非负
        y_erp = std::clamp(y_erp, 0.0, static_cast<double>(erp_h - 1));

        mx_row[u] = static_cast<float>(x_erp);
        my_row[u] = static_cast<float>(y_erp);
      }
    }
  };
  // Pixels are independent. Two stripes bound CPU competition with SRS/recording;
  // do not change OpenCV's process-wide thread count or floating-point formulas.
  if (size_t(w_out) * h_out >= 256 * 256)
    cv::parallel_for_(cv::Range(0, h_out), fill_rows, 2);
  else
    fill_rows(cv::Range(0, h_out));
  return {map_x, map_y};
#endif
}

cv::Mat SampleErpPerspective(const cv::Mat& erp_img, const cv::Mat& map_x, const cv::Mat& map_y) {
#ifdef AINVR_ERP_METADATA_ONLY
  throw std::runtime_error("CPU ERP sampling is a test oracle only");
#else
  cv::Mat out;
  cv::remap(erp_img, out, map_x, map_y, cv::INTER_CUBIC, cv::BORDER_REPLICATE);
  return out;
#endif
}

// ---- ErpMapCache ----

ErpMapCache::ErpMapCache(double bucket_deg, size_t max_entries, size_t max_bytes)
    : bucket_deg_(bucket_deg), max_entries_(max_entries), max_bytes_(max_bytes) {}

namespace {
size_t MapBytes(const std::pair<cv::Mat, cv::Mat>& maps) {
  return maps.first.total() * maps.first.elemSize() + maps.second.total() * maps.second.elemSize();
}
}  // namespace

ErpMapCache::Key ErpMapCache::MakeKey(int erp_w, int erp_h, const ErpView& view) const {
  double yaw_deg = (view.cx / erp_w - 0.5) * 360.0;
  double pitch_deg = (0.5 - view.cy / erp_h) * 180.0;
  return Key{erp_w, erp_h, static_cast<int64_t>(PyRound(yaw_deg / bucket_deg_)),
             static_cast<int64_t>(PyRound(pitch_deg / bucket_deg_)),
             static_cast<int64_t>(PyRound(view.fov_h_deg / bucket_deg_)), view.w_out,
             view.h_out};
}

std::pair<cv::Mat, cv::Mat> ErpMapCache::GetOrBuild(int erp_w, int erp_h, const ErpView& view) {
  Key key = MakeKey(erp_w, erp_h, view);
  std::lock_guard<std::mutex> lock(mutex_);

  auto it = index_.find(key);
  if (it != index_.end()) {
    // LRU:命中项移到链表尾部(最近使用)。
    lru_.splice(lru_.end(), lru_, it->second);
    return it->second->second;
  }

  auto maps = BuildErpMap(erp_w, erp_h, view.cx, view.cy, view.fov_h_deg, view.w_out, view.h_out);
  lru_.emplace_back(key, maps);
  index_[key] = std::prev(lru_.end());
  bytes_ += MapBytes(maps);

  while (lru_.size() > 1 && (lru_.size() > max_entries_ || bytes_ > max_bytes_)) {
    bytes_ -= MapBytes(lru_.front().second);
    index_.erase(lru_.front().first);
    lru_.pop_front();
  }
  return maps;
}

size_t ErpMapCache::Size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return lru_.size();
}

}  // namespace ai_service::output

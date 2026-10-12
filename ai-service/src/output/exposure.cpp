#include "exposure.hpp"

#include <algorithm>
#include <cmath>
#include <mutex>
#include <stdexcept>

#include <opencv2/imgproc.hpp>

#include <array>

namespace ai_service::output {

namespace {

// ---- 保守算法默认参数(与参考实现一致) ----
constexpr double kGuidedEps = 0.04;

std::once_flag g_lut_once;
std::array<float, 256> g_dec_lut;   // sRGB uint8 -> 线性 float32
float g_ceiling_y = 0.0f;           // 254/255 sRGB 对应的线性亮度
constexpr int kEncGrid = 65535;     // Finer dark-tone quantization, 64 KiB LUT.
std::array<uint8_t, kEncGrid + 1> g_enc_lut;

float SrgbToLinear(float x) {
  return x <= 0.04045f ? x / 12.92f : std::pow((x + 0.055f) / 1.055f, 2.4f);
}
float LinearToSrgb(float x) {
  x = std::clamp(x, 0.0f, 1.0f);
  return x <= 0.0031308f ? 12.92f * x : 1.055f * std::pow(x, 1.0f / 2.4f) - 0.055f;
}
void EnsureLutsBuilt() {
  std::call_once(g_lut_once, [] {
    for (int i = 0; i < 256; ++i) g_dec_lut[i] = SrgbToLinear(static_cast<float>(i) / 255.0f);
    g_ceiling_y = g_dec_lut[254];
    for (int i = 0; i <= kEncGrid; ++i) {
      float lin = static_cast<float>(i) / kEncGrid;
      float srgb255 = LinearToSrgb(lin) * 255.0f;
      int v = static_cast<int>(std::nearbyint(srgb255));
      g_enc_lut[i] = static_cast<uint8_t>(std::clamp(v, 0, 255));
    }
  });
}

// UI target(旧 uint8 Lab L 的 0..255 刻度) -> 线性相对亮度 Y/Yn。
double TargetToLuminance(double target) {
  double lstar = target * 100.0 / 255.0;
  if (lstar > 8.0) return std::pow((lstar + 16.0) / 116.0, 3.0);
  return lstar / (24389.0 / 27.0);
}

// 浮点单通道引导滤波(5 次 boxFilter,无需 opencv-contrib)。输入/输出都是
// log2 档数尺度的 float32。
cv::Mat GuidedFilter(const cv::Mat& guide, const cv::Mat& src, int radius,
                      double eps = kGuidedEps) {
  cv::Size size(2 * radius + 1, 2 * radius + 1);
  auto mean = [&](const cv::Mat& x) {
    cv::Mat m;
    cv::boxFilter(x, m, CV_32F, size, cv::Point(-1, -1), true, cv::BORDER_REFLECT_101);
    return m;
  };
  cv::Mat mean_i = mean(guide);
  cv::Mat mean_p = mean(src);
  cv::Mat guide_sq;
  cv::multiply(guide, guide, guide_sq);
  cv::Mat var_i = mean(guide_sq) - mean_i.mul(mean_i);
  cv::max(var_i, 0.0, var_i);
  cv::Mat guide_src;
  cv::multiply(guide, src, guide_src);
  cv::Mat cov_ip = mean(guide_src) - mean_i.mul(mean_p);
  cv::Mat a = cov_ip / (var_i + eps);
  cv::Mat b = mean_p - a.mul(mean_i);
  return mean(a).mul(guide) + mean(b);
}

// 局部光照 base(log2 档数):面积降采样 -> 双边滤波(保边)-> 线性上采样
// -> 原图引导滤波修补边界泄漏。双边走 gpu_image(CUDA/CPU 自动回退)。
cv::Mat ComputeBase(const cv::Mat& log_y, double scene_scale, double sigma_color) {
  int h = log_y.rows, w = log_y.cols;
  double radius = std::max(1.0, std::min(h, w) * scene_scale);
  double reduction = std::max(1.0, radius / 8.0);
  int sw = std::max(1, static_cast<int>(std::nearbyint(w / reduction)));
  int sh = std::max(1, static_cast<int>(std::nearbyint(h / reduction)));

  cv::Mat small;
  cv::resize(log_y, small, cv::Size(sw, sh), 0, 0, cv::INTER_AREA);

  double sigma_space =
      std::max(0.5, radius * std::min(static_cast<double>(sw) / w, static_cast<double>(sh) / h));
  int diameter = 2 * std::max(1, static_cast<int>(std::ceil(2 * sigma_space))) + 1;
  cv::Mat base_small;
  cv::bilateralFilter(small, base_small, diameter, sigma_color, sigma_space, cv::BORDER_REFLECT_101);

  cv::Mat base_up;
  cv::resize(base_small, base_up, cv::Size(w, h), 0, 0, cv::INTER_LINEAR);

  int guide_radius = std::max(1, static_cast<int>(std::nearbyint(reduction * 2)));
  cv::Mat base = GuidedFilter(log_y, base_up, guide_radius);

  double min_v, max_v;
  cv::minMaxLoc(log_y, &min_v, &max_v);
  cv::max(base, min_v, base);
  cv::min(base, max_v, base);
  return base;
}

}  // namespace

cv::Mat CorrectExposure(const cv::Mat& img_bgr, double target, double strength, double max_stops,
                         double scene_scale, double sigma_color, double dead_zone, bool accelerate) {
  if (img_bgr.empty() || img_bgr.type() != CV_8UC3) {
    throw std::invalid_argument("输入必须是非空 H×W×3 uint8 BGR 图片");
  }
  for (double v : {target, strength, max_stops, scene_scale, sigma_color, dead_zone}) {
    if (!std::isfinite(v)) throw std::invalid_argument("参数必须为有限数值");
  }
  if (target < 0.0 || target > 255.0 || strength < 0.0 || strength > 1.0) {
    throw std::invalid_argument("target 必须在 [0,255],strength 必须在 [0,1]");
  }
  if (max_stops < 0.0 || max_stops > 4.0 || scene_scale <= 0.0 || scene_scale > 0.5) {
    throw std::invalid_argument("max_stops 必须在 [0,4],scene_scale 必须在 (0,0.5]");
  }
  if (sigma_color <= 0.0 || sigma_color > 8.0 || dead_zone < 0.0 || dead_zone > 4.0) {
    throw std::invalid_argument("sigma_color 必须在 (0,8] 档,dead_zone 必须在 [0,4] 档");
  }
  if (strength == 0.0 || max_stops == 0.0) return img_bgr.clone();

  // S100P: preserve the reference CPU algorithm as the quality baseline.
  // GLES acceleration is not implemented here; accelerate is a preference.
  (void)accelerate;

  EnsureLutsBuilt();
  int h = img_bgr.rows, w = img_bgr.cols;

  // sRGB uint8 -> 线性 f32(逐通道 LUT),同时算出未做 log 保护的原始亮度 y
  // (noise_guard 要用这份原始值,不能用 log_y 反推)。
  cv::Mat rgb(h, w, CV_32FC3);
  cv::Mat y_mat(h, w, CV_32FC1);
  cv::Mat log_y(h, w, CV_32FC1);
  for (int r = 0; r < h; ++r) {
    const cv::Vec3b* src_row = img_bgr.ptr<cv::Vec3b>(r);
    cv::Vec3f* rgb_row = rgb.ptr<cv::Vec3f>(r);
    float* y_row = y_mat.ptr<float>(r);
    float* logy_row = log_y.ptr<float>(r);
    for (int c = 0; c < w; ++c) {
      float b = g_dec_lut[src_row[c][0]];
      float g = g_dec_lut[src_row[c][1]];
      float rr = g_dec_lut[src_row[c][2]];
      rgb_row[c] = cv::Vec3f(b, g, rr);
      // BT.709 亮度公式 Y=0.2126R+0.7152G+0.0722B,数组按 BGR 索引排列
      // (索引0是B通道系数0.0722,索引2是R通道系数0.2126)——这个顺序看起来
      // "反直觉"但跟输入的 BGR 通道顺序对应,照抄 Python 版,不要按直觉
      // 重排。
      float y = b * 0.0722f + g * 0.7152f + rr * 0.2126f;
      y_row[c] = y;
      logy_row[c] = std::log2(std::max(y, 1e-6f));
    }
  }

  float target_log = static_cast<float>(std::log2(std::max(TargetToLuminance(target), 1e-6)));
  cv::Mat base = ComputeBase(log_y, scene_scale, sigma_color);

  cv::Mat result = img_bgr.clone();
  for (int r = 0; r < h; ++r) {
    const cv::Vec3b* src_row = img_bgr.ptr<cv::Vec3b>(r);
    const cv::Vec3f* rgb_row = rgb.ptr<cv::Vec3f>(r);
    const float* y_row = y_mat.ptr<float>(r);
    const float* logy_row = log_y.ptr<float>(r);
    const float* base_row = base.ptr<float>(r);
    cv::Vec3b* out_row = result.ptr<cv::Vec3b>(r);
    for (int c = 0; c < w; ++c) {
      float delta = target_log - base_row[c];
      float distance = std::max(std::fabs(delta) - static_cast<float>(dead_zone), 0.0f);
      // Extra headroom only for locally dark regions being lifted. Ordinary
      // midtones and all darkening keep the previous 1.5-stop cap.
      float darkness = std::clamp((-3.058894f - base_row[c]) / 3.321928f, 0.0f, 1.0f);
      darkness = darkness * darkness * (3.0f - 2.0f * darkness);
      float cap = std::min(static_cast<float>(max_stops),
                           delta > 0 ? 1.5f + 1.5f * darkness : 1.5f);
      float stops =
          std::copysign(std::min(distance, cap), delta) *
          static_cast<float>(strength);

      // 极暗区域渐进抑制提亮,减少量化误差/噪声被放大。
      float y = y_row[c];
      float noise_guard = y / (y + 0.003f);
      if (stops > 0.0f) stops *= noise_guard;

      // Smoothly approach the target instead of clamping many textured pixels
      // to exactly the same luminance. For fixed magnitude in log-luminance,
      // k < 1 preserves a positive slope (1-k); quantization and spatially
      // varying illumination still prevent a global monotonicity guarantee.
      float pixel_delta = target_log - logy_row[c];
      if (stops * pixel_delta > 0.0f) {
        constexpr float kTargetApproach = 0.7f;
        float magnitude = std::fabs(stops);
        float distance_to_target = std::fabs(pixel_delta);
        // This branch guarantees magnitude > 0. expm1 retains precision near
        // the target. 1-exp(-x) <= x keeps the adjustment below the distance.
        float softened = kTargetApproach * magnitude *
                         -std::expm1(-distance_to_target / magnitude);
        stops = std::copysign(softened, stops);
      } else {
        stops = 0.0f;
      }

      float gain = std::exp2(stops);

      cv::Vec3f rgbv = rgb_row[c];
      float peak = std::max({rgbv[0], rgbv[1], rgbv[2]});
      float gain_limit = std::max(1.0f, g_ceiling_y / std::max(peak, 1e-8f));
      gain = std::min(gain, gain_limit);

      cv::Vec3b out;
      if (stops == 0.0f) {
        // 死区/反向像素严格原样返回,不吃重编码的 ±1 级抖动。
        out = src_row[c];
      } else {
        cv::Vec3f scaled = rgbv * gain;
        for (int ch = 0; ch < 3; ++ch) {
          int idx = static_cast<int>(std::nearbyint(scaled[ch] * kEncGrid));
          idx = std::clamp(idx, 0, kEncGrid);
          out[ch] = g_enc_lut[idx];
        }
      }

      // 8-bit 量化端点保护(对 stops==0 分支是 no-op:此时 out==src,
      // "src>0 且 out==0"这个条件不可能同时成立)。
      for (int ch = 0; ch < 3; ++ch) {
        if (src_row[c][ch] > 0 && out[ch] == 0) out[ch] = 1;
        if (src_row[c][ch] < 255 && out[ch] == 255) out[ch] = 254;
      }
      out_row[c] = out;
    }
  }
  return result;
}

cv::Mat CorrectExposureRgba(const cv::Mat& img_rgba, double target, double strength) {
  cv::Mat bgr;
  cv::cvtColor(img_rgba, bgr, cv::COLOR_RGBA2BGR);
  cv::Mat corrected = CorrectExposure(bgr, target, strength);
  cv::Mat rgba;
  cv::cvtColor(corrected, rgba, cv::COLOR_BGR2RGBA);
  // cvtColor BGR2RGBA 会把 alpha 填成 255,不是原值——必须自己把原 alpha
  // 带回去(cvtColor 往返不保留 alpha)。
  for (int r = 0; r < img_rgba.rows; ++r) {
    const cv::Vec4b* src_row = img_rgba.ptr<cv::Vec4b>(r);
    cv::Vec4b* dst_row = rgba.ptr<cv::Vec4b>(r);
    for (int c = 0; c < img_rgba.cols; ++c) dst_row[c][3] = src_row[c][3];
  }
  return rgba;
}

}  // namespace ai_service::output

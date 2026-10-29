// Pure geometry proxy. No image decoding, confidence, motion or appearance claim.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
namespace ai_service::output {
inline constexpr const char* kSearchPixelSupportMetric = "pixel_support_edge_proxy_v1";
// sqrt(visible source-pixel area / full source area), discounted by the
// visible fraction and 25% when touching an image edge. This is a bounded
// preference for larger, untruncated detections, NOT measured image quality.
inline std::optional<double> SearchObjectPixelSupport(const std::array<double,4>& box,
    int observation_width, int observation_height, int raw_width, int raw_height) {
  if (observation_width<=0 || observation_height<=0 || raw_width<=0 || raw_height<=0 ||
      observation_width>16384 || observation_height>16384 || raw_width>16384 || raw_height>16384 ||
      !std::all_of(box.begin(),box.end(),[](double v){return std::isfinite(v)&&std::abs(v)<=131072;}) ||
      box[2]<=0 || box[3]<=0) return {};
  const double x0=std::clamp(box[0],0.0,double(observation_width));
  const double y0=std::clamp(box[1],0.0,double(observation_height));
  const double x1=std::clamp(box[0]+box[2],0.0,double(observation_width));
  const double y1=std::clamp(box[1]+box[3],0.0,double(observation_height));
  if (x1<=x0 || y1<=y0) return {};
  const double visible=(x1-x0)*(y1-y0);
  const double raw_area=visible*double(raw_width)/observation_width*double(raw_height)/observation_height;
  const double fraction=std::min(1.0,visible/(box[2]*box[3]));
  const bool edge=x0<=0 || y0<=0 || x1>=observation_width || y1>=observation_height;
  return std::clamp(std::sqrt(raw_area/(double(raw_width)*raw_height))*fraction*(edge?.75:1.0),0.0,1.0);
}
} // namespace ai_service::output

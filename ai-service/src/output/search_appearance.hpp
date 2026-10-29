// Descriptor math only. Never consumes an image or runs a CPU model.
#pragma once
#include <algorithm>
#include <cmath>
#include <optional>
#include <span>
#include <string>
namespace ai_service::output {
inline constexpr const char* kSearchAppearanceMetric="cosine_distance_v1";
struct SearchAppearanceAudit {
  std::string reference_fingerprint;
  double distance=0,threshold=.25;
};
// 1 - cosine(unit(a),unit(b)), in [0,2]. Non-finite/zero/mismatched spaces
// fail closed, never look like NoChange. Thresholds are experimental, not
// calibrated probabilities or a claim of semantic correctness.
inline std::optional<double> SearchAppearanceDistance(std::span<const float> a,std::span<const float> b) {
  if(a.empty()||a.size()!=b.size()||a.size()>4096)return {};
  long double dot=0,aa=0,bb=0;
  for(size_t i=0;i<a.size();++i){if(!std::isfinite(a[i])||!std::isfinite(b[i]))return {};
    dot+=static_cast<long double>(a[i])*b[i];aa+=static_cast<long double>(a[i])*a[i];bb+=static_cast<long double>(b[i])*b[i];}
  if(aa<1e-20L||bb<1e-20L)return {};
  const auto cosine=dot/std::sqrt(aa*bb);
  if(!std::isfinite(cosine))return {};
  return double(1-std::clamp(cosine,-1.0L,1.0L));
}
} // namespace ai_service::output

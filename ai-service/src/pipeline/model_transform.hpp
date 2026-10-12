// Copyright AINVR. Model normalization and channel preprocessing contract.
#pragma once
#include "preprocess_config.hpp"
#include "platform/gles_preprocess.hpp"
#include <cmath>
#include <limits>
#include <stdexcept>

namespace ainvr {
inline ImageTransform ModelTransform(
    const ai_service::pipeline::PreprocessConfig& config, bool scrfd) {
  ai_service::pipeline::PreprocessConfig defaults;
  if (scrfd) {
    defaults.mean = {127.5,127.5,127.5};
    defaults.std = {128,128,128};
  }
  const auto resolved = ai_service::pipeline::ResolvePreprocess(config, defaults);
  // Detection coordinate restoration currently uses a uniform letterbox scale.
  // Reject stretching until both the image and box transforms support it.
  if (!resolved.letterbox)
    throw std::invalid_argument("Detection preprocessing requires letterbox");
  if (resolved.interpolation != "bilinear" && resolved.interpolation != "nearest")
    throw std::invalid_argument("Detection interpolation currently supports bilinear or nearest");
  ImageTransform transform;
  transform.letterbox = resolved.letterbox;
  transform.nearest = resolved.interpolation == "nearest";
  transform.bgr = !resolved.rgb_order;
  for (size_t i=0;i<3;++i) {
    if (resolved.padding_color[i]<0 || resolved.padding_color[i]>255)
      throw std::invalid_argument("Invalid preprocessing padding color");
    transform.padding[i] = resolved.padding_color[i];
    if (!std::isfinite(resolved.mean[i]) || !std::isfinite(resolved.std[i]) ||
        resolved.std[i]<=0 || std::abs(resolved.mean[i])>std::numeric_limits<float>::max() ||
        resolved.std[i]>std::numeric_limits<float>::max() ||
        static_cast<float>(resolved.std[i])==0)
      throw std::invalid_argument("Invalid preprocessing normalization");
    transform.mean[i] = resolved.normalize ? resolved.mean[i] : 0;
    transform.divisor[i] = resolved.normalize ? resolved.std[i] : 1;
  }
  return transform;
}
}

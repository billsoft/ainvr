// Copyright AINVR. Original restoration pixel rules executed on Mali.
#pragma once
#include <atomic>
#include <cstdint>
#include <vector>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
namespace ainvr {
struct FaceRestoreInput {
  int size = 0;
  cv::Rect valid;
  std::vector<float> nchw;
};
struct FaceRestoreStats { uint64_t prepared, blended, failures, cpu_runs; };
FaceRestoreStats GetFaceRestoreStats();
FaceRestoreInput PrepareFaceRestoreGles(const cv::Mat& rgba, int size);
// Output bytes retain the SDK float32 NCHW byte strides. GPU performs blending,
// clipping, truncation, gray-border restoration and alpha=255, without CPU math.
cv::Mat FinishFaceRestoreGles(const FaceRestoreInput& input,
    const std::vector<unsigned char>& output, const nlohmann::json& descriptor,
    double blend);
}

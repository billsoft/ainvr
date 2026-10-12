// Copyright AINVR.
#pragma once
#include <cstdint>
#include <vector>
#include <opencv2/core.hpp>
namespace ai_service::output {
struct SnapshotJpegStats { uint64_t jpu, cpu, failures, gpu_color, encoder_creates, encoder_reuses; };
SnapshotJpegStats GetSnapshotJpegStats();
// Preserve tiny RGBA crop pixels and add replicated right/bottom edge pixels
// on GLES so the JPU's minimum MCU grid is met. Larger crops are unchanged.
cv::Mat EnsureSnapshotJpuCanvas(const cv::Mat& rgba);
// Input is BGR8, including non-contiguous ROI. GPU color conversion -> JPU.
// Visible dimensions 17..8192, including odd sizes. Tiny unsupported crops
// and hardware failures report errors; no production CPU image fallback.
bool EncodeSnapshotJpeg(const cv::Mat& bgr, std::vector<uint8_t>& out, int quality);
// Native archive RGBA8 -> GPU color/padding -> JPU. Non-contiguous ROIs are
// copied as bytes only, alpha is ignored. Same dimensions and failure contract.
bool EncodeSnapshotRgbaJpeg(const cv::Mat& rgba, std::vector<uint8_t>& out, int quality);
}

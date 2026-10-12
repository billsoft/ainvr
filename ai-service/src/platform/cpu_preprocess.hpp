// Copyright AINVR. Last-resort portable reference; no CUDA/OpenCV dependency.
#pragma once
#include "gles_preprocess.hpp"
#include "vpu_decoder.hpp"
namespace ainvr {
void ValidateTransform(const Nv12Frame& input,const ImageTransform& transform);
std::vector<float> CpuPreprocess(const Nv12Frame& input,const ImageTransform& transform);
}

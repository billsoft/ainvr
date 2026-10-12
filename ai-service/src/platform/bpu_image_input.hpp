// Copyright AINVR. Byte layout only; image math runs in dedicated hardware/GLES.
#pragma once
#include <cstdint>
#include <vector>
#include <map>
#include <string>
#include <nlohmann/json.hpp>
namespace ainvr {
std::vector<unsigned char> PackBpuFloatNchw(const std::vector<float>& values,
                                          const nlohmann::json& descriptor);
// Auxiliary tensors contain BPU-produced embeddings, never CPU NN results.
std::vector<unsigned char> PackBpuFloatTensor(const std::vector<float>& values,
                                            const nlohmann::json& descriptor);
size_t BpuFloatImageInputIndex(const nlohmann::json& descriptors,
                              const std::string& image_name);
std::vector<std::vector<unsigned char>> PackBpuFloatInputs(
    const std::vector<float>& image, const nlohmann::json& descriptors,
    const std::string& image_name,
    const std::map<std::string, std::vector<float>>& auxiliary);
std::vector<std::vector<unsigned char>> PackBpuNv12(
    const std::vector<uint8_t>& pixels, int width, int height,
    const nlohmann::json& input_descriptors);
}

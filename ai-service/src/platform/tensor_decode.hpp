// Copyright AINVR. Decode padded/quantized HBM outputs into dense float tensors.
#pragma once
#include <cstdint>
#include <vector>
#include <nlohmann/json.hpp>
namespace ainvr {
std::vector<float> DecodeTensor(const std::vector<unsigned char>& bytes,
                                const nlohmann::json& description);
}

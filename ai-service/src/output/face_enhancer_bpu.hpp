// Copyright AINVR. BPU model loading behind the original restoration interface.
#pragma once
#include <filesystem>
#include <nlohmann/json.hpp>
#include "face_enhancer.hpp"
namespace ai_service::output {
nlohmann::json ValidateFaceEnhanceBpuManifest(const std::string& model,
                                            const std::filesystem::path& path);
std::shared_ptr<FaceEnhancer> CreateFaceEnhancerBpu(const std::string& model,
                                                  const std::string& path);
void RegisterFaceEnhancerBpu(const std::filesystem::path& model_root);
}

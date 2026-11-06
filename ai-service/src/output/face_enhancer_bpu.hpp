// Copyright AINVR. BPU model loading behind the original restoration interface.
#pragma once
#include <filesystem>
#include <set>
#include <nlohmann/json.hpp>
#include "face_enhancer.hpp"
namespace ai_service::output {
nlohmann::json ValidateFaceEnhanceBpuManifest(const std::string& model,
                                            const std::filesystem::path& path);
std::shared_ptr<FaceEnhancer> CreateFaceEnhancerBpu(const std::string& model,
                                                  const std::string& path);
void RetainConfiguredFaceEnhancers(const std::set<std::string>& absolute_paths);
void DrainRetiredFaceEnhancers();
void RegisterFaceEnhancerBpu(const std::filesystem::path& model_root);
}

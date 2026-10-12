// Copyright AINVR. Hardware-independent enhancement contract.
#pragma once
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <opencv2/core.hpp>
namespace ai_service::output {
struct FaceEnhanceModelSpec { int size; std::string name; };
const std::unordered_map<std::string, FaceEnhanceModelSpec>& FaceEnhanceModelSpecs();
bool ShouldEnhance(int width, int height, int size);
class FaceEnhancer {
 public:
  virtual ~FaceEnhancer() = default;
  virtual void EnsureLoaded() = 0;
  virtual cv::Mat EnhanceRgba(const cv::Mat&, double blend = 0.5) = 0;
};
using FaceEnhancerFactory = std::function<std::shared_ptr<FaceEnhancer>(const std::string&, const std::string&)>;
// Register during startup. Missing backends fail explicitly; no fabricated enhancement.
void RegisterFaceEnhancerFactory(FaceEnhancerFactory factory);
std::shared_ptr<FaceEnhancer> GetFaceEnhancer(const std::string& model, const std::string& path);
}

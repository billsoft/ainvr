#include "face_enhancer.hpp"
#include <mutex>
#include <stdexcept>
namespace ai_service::output {
namespace { std::mutex factory_mutex; FaceEnhancerFactory factory; }
const std::unordered_map<std::string, FaceEnhanceModelSpec>& FaceEnhanceModelSpecs() {
  static const std::unordered_map<std::string, FaceEnhanceModelSpec> specs = {
      {"gpen", {256, "gpen_bfr_256"}},
      {"codeformer", {512, "codeformer_512"}},
  };
  return specs;
}

bool ShouldEnhance(int width, int height, int size) {
  return width > 0 && width < size && height > 0 && height < size;
}


void RegisterFaceEnhancerFactory(FaceEnhancerFactory value) {
  if (!value) throw std::invalid_argument("enhancement factory is empty");
  std::lock_guard<std::mutex> lock(factory_mutex);
  if (factory) throw std::logic_error("enhancement backend already registered");
  factory=std::move(value);
}
std::shared_ptr<FaceEnhancer> GetFaceEnhancer(const std::string& model,const std::string& path) {
  FaceEnhanceModelSpecs().at(model);
  FaceEnhancerFactory selected;
  { std::lock_guard<std::mutex> lock(factory_mutex); selected=factory; }
  if (!selected) throw std::runtime_error("Configured face enhancement backend is unavailable on this device");
  auto result=selected(model,path);
  if (!result) throw std::runtime_error("Enhancement backend returned no model");
  return result;
}
}

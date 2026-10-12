// Copyright AINVR. Task metadata is independent of execution availability.
#include "factory.hpp"
#include <algorithm>
namespace ai_service::adapters {
namespace {
class TaskMetadata final : public BaseModelAdapter {
 public:
  explicit TaskMetadata(const config::ModelConfig& cfg):adapter_(cfg.adapter) {
    ApplyTaskTypeHint(cfg.class_names.value_or(std::vector<std::string>{}), cfg.name, cfg.path);
  }
  void Load(const std::string&, const std::string&, const std::string&) override {
    throw std::runtime_error("Task metadata cannot execute a model; a verified BPU backend is required");
  }
  std::string ActualProvider() const override { return "unavailable"; }
  // Preserve the reference adapter's intrinsic task/crop/output properties
  // before model loading too. Renaming an artifact cannot change its task.
  std::string TaskType() const override {
    return (adapter_=="yoloface_bpu"||adapter_=="scrfd_bpu")
      ?"face_detection":BaseModelAdapter::TaskType();
  }
  bool SquareSnapshotCrop() const override {return adapter_=="yoloface_bpu";}
  bool IsMultiOutput() const override {return adapter_=="scrfd_bpu";}
 private:
  std::string adapter_;
};
}
std::vector<std::string> AvailableAdapters() {
  return {"yolo26_bpu", "yoloface_bpu", "scrfd_bpu", "yoloe_bpu", "locateanything_bpu"};
}
std::unique_ptr<BaseModelAdapter> CreateAdapter(const config::ModelConfig& cfg) {
  return std::make_unique<TaskMetadata>(cfg);
}
}

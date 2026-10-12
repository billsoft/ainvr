// 模型适配器基类 —— 对应 Python adapters/base.py。
#pragma once

#include <cctype>
#include <functional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <opencv2/core.hpp>

#include "../output/result.hpp"
#include "../pipeline/preprocess_config.hpp"
#include "../pipeline/scale_info.hpp"

namespace ai_service::adapters {

class BaseModelAdapter {
 public:
  virtual ~BaseModelAdapter() = default;

  virtual void Load(const std::string& model_path, const std::string& provider,
                     const std::string& engine_cache) = 0;

  // 单输出模型(YOLO 系列)走这一对。多输出模型(SCRFD)改走下面的
  // InferMulti/PostprocessMulti——IsMultiOutput()==true 的子类不需要
  // (也不应该)覆盖这两个方法,基类默认实现直接抛异常,防止被误调。
  virtual std::vector<float> Infer(const std::vector<float>& input_nchw) {
    throw std::runtime_error("单输出模型的 Infer() 未实现");
  }
  virtual std::vector<Detection> Postprocess(const std::vector<float>& raw_output,
                                              const pipeline::ScaleInfo& scale_info,
                                              double conf_th, double iou_th, int max_det) {
    throw std::runtime_error("单输出模型的 Postprocess() 未实现");
  }

  // 多态开关:子类置 true 声明"本模型是多输出模型(SCRFD:9 个输出张量),
  // channel_worker 要走 InferMulti/PostprocessMulti 这一对,不是
  // Infer/Postprocess"。默认 false(YOLO 系列走单输出路径)。
  virtual bool IsMultiOutput() const { return false; }
  // 慢速开放词汇模型使用独立执行器，输入是脱离解码缓冲的原始 RGBA 图。
  virtual bool IsPrompted() const { return false; }
  virtual nlohmann::json InferPrompted(const cv::Mat&, const std::string&, int,
                                     const std::function<bool()>&) {
    throw std::runtime_error("模型不支持开放词汇推理");
  }
  virtual std::vector<std::vector<float>> InferMulti(const std::vector<float>& input_nchw) {
    throw std::runtime_error("单输出模型不支持 InferMulti()");
  }
  virtual std::vector<Detection> PostprocessMulti(
      const std::vector<std::vector<float>>& raw_outputs, const pipeline::ScaleInfo& scale_info,
      double conf_th, double iou_th, int max_det) {
    throw std::runtime_error("单输出模型不支持 PostprocessMulti()");
  }

  // ---- 模型输入契约:预处理按它来,换模型时整套跟着换 ----
  //
  // 动态 shape 模型(SCRFD)按请求尺寸构建/设置 engine;固定 shape 的 engine
  // 忽略请求、以 engine 自身为准。必须在 Load() 之前调用。
  virtual void SetRequestedInputSize(int h, int w) {
    requested_h_ = h;
    requested_w_ = w;
  }
  // (h, w):Load() 之后是模型实际输入尺寸,之前是请求尺寸。
  virtual std::pair<int, int> InputSize() const { return {requested_h_, requested_w_}; }
  // 模型族要求的归一化与通道顺序,通道配置没显式指定时使用
  // (pipeline::ResolvePreprocess)。默认 YOLO 系:pix/255、RGB。
  virtual pipeline::PreprocessConfig DefaultPreprocess() const { return {}; }

  // 推理输入缓冲(device,float NCHW,InputSize 大小)与推理所用 stream:
  // 预处理直接写进来,再调 RunPrepared/RunPreparedMulti,全程不经 CPU。
  virtual float* DeviceInput() { throw std::runtime_error("模型未加载"); }
  // Execution queues belong to each S100P backend, not the shared model contract.
  virtual std::vector<float> RunPrepared() {
    throw std::runtime_error("单输出模型的 RunPrepared() 未实现");
  }
  virtual std::vector<std::vector<float>> RunPreparedMulti() {
    throw std::runtime_error("单输出模型不支持 RunPreparedMulti()");
  }

  virtual std::string ActualProvider() const = 0;
  virtual nlohmann::json ResultMetadata() const { return nlohmann::json::object(); }

  // FrameResult.task_type 从这里读——子类按任务性质覆盖(YoloFace/SCRFD
  // 直接返回 face_detection);默认实现返回 task_type_,由工厂调用
  // ApplyTaskTypeHint 推导。
  virtual std::string TaskType() const { return task_type_; }

  // v1 BaseModelAdapter.__init__ 的推导规则:只对"类自身默认是
  // object_detection"的适配器生效——class_names 恰好是 {face}(忽略大小
  // 写),或 "name path" 里含 face/scrfd,判定为 face_detection。生产的人脸
  // 模型也可能挂在通用 yolo26_trt 上,不推导的话下游只对人脸生效的能力
  // (识别历史的人脸增强)会被静默跳过。
  void ApplyTaskTypeHint(const std::vector<std::string>& class_names,
                         const std::string& model_name, const std::string& model_path) {
    if (TaskType() != "object_detection") return;
    auto lower = [](std::string s) {
      for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      return s;
    };
    bool only_face = !class_names.empty();
    for (auto&& n : class_names) {
      if (lower(n) != "face") only_face = false;
    }
    std::string hint = lower(model_name + " " + model_path);
    if (only_face || hint.find("face") != std::string::npos ||
        hint.find("scrfd") != std::string::npos) {
      task_type_ = "face_detection";
    }
  }

  // 多态开关:子类置 true 声明"本模型写出的 bbox 是以目标中心为不动点的
  // 正方形,入库截图也必须按正方形取景"(见 YoloFaceTrtAdapter)。裁剪端
  // 只读这个属性,不判断具体是哪个模型。
  virtual bool SquareSnapshotCrop() const { return false; }

 private:
  std::string task_type_ = "object_detection";

 protected:
  int requested_h_ = 640, requested_w_ = 640;
};

}  // namespace ai_service::adapters

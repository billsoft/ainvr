// 纯数据的预处理配置 —— 故意从 preprocessor.hpp 里拆出来,不带任何 OpenCV
// 依赖。config.cpp 只需要这个结构体本身(用来填 ChannelConfig.preprocess),
// 不需要因此把 OpenCV/CUDA 头文件也一起拖进每一个引用配置类型的地方。
#pragma once

#include <array>
#include <string>

namespace ai_service::pipeline {

struct PreprocessConfig {
  bool letterbox = true;
  std::array<int, 3> padding_color = {114, 114, 114};
  // nearest/bilinear/bicubic/area/lanczos4
  std::string interpolation = "bilinear";
  bool normalize = true;
  std::array<double, 3> mean = {0.0, 0.0, 0.0};
  std::array<double, 3> std = {255.0, 255.0, 255.0};
  bool rgb_order = true;  // true=RGB, false=BGR
  // 通道配置里是否显式写了 normalize/mean/std/rgb_order 任一项。没写时用
  // 模型族(检测器子类)自己声明的默认值,见 ResolvePreprocess。
  bool normalization_explicit = false;
};

// 模型实际使用的预处理:缩放/灰边/插值取通道配置;归一化与通道顺序是模型
// 的输入契约——配置没显式写就用模型族默认值(BaseModelAdapter::DefaultPreprocess),
// 换模型时随之整套切换。
inline PreprocessConfig ResolvePreprocess(const PreprocessConfig& cfg,
                                          const PreprocessConfig& model_default) {
  if (cfg.normalization_explicit) return cfg;
  PreprocessConfig r = cfg;
  r.normalize = model_default.normalize;
  r.mean = model_default.mean;
  r.std = model_default.std;
  r.rgb_order = model_default.rgb_order;
  return r;
}

}  // namespace ai_service::pipeline

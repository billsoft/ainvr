// 对应 Python preprocessor.py 里的 ScaleInfo/compute_scale —— letterbox
// 缩放参数计算是纯 CPU 逻辑,后处理坐标还原(postprocessor.cpp)要用,提前
// 从 preprocessor 模块里摘出来,不用等 GPU 预处理那部分移植完。
#pragma once

namespace ai_service::pipeline {

struct ScaleInfo {
  int orig_w = 0, orig_h = 0;
  int target_w = 0, target_h = 0;
  double scale = 1.0;
  int pad_left = 0, pad_top = 0;
  int new_w = 0, new_h = 0;
};

ScaleInfo compute_scale(int orig_w, int orig_h, int target_w, int target_h);

}  // namespace ai_service::pipeline

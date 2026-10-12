// 截图局部亮度(曝光)校正：保边光照估计 + 平滑目标约束。
// 保守的单张 sRGB/BGR uint8 局部亮度校正,在线性光 + log2 曝光档数域工作。
// 目标约束采用软过渡，避免旧版硬截断抹平中间调；与旧 Python 输出不再逐像素相同。
#pragma once

#include <opencv2/core.hpp>

namespace ai_service::output {

// 输入/输出均为 HxWx3 uint8 BGR(sRGB SDR 截图)。target:目标亮度,沿用
// 旧版 0..255 Lab L 刻度(UI 滑块 0-255)。strength:[0,1],0 时直接返回
// 原图副本。非法输入抛 std::invalid_argument——调用方(snapshot_store)
// 负责重试与故障上报。
cv::Mat CorrectExposure(const cv::Mat& img_bgr, double target = 128.0, double strength = 0.6,
                         double max_stops = 3.0, double scene_scale = 0.10,
                         double sigma_color = 0.8, double dead_zone = 0.20,
                         bool accelerate = true);

// 归档链路专用入口:输入/输出都是 RGBA uint8(与 frame.data、face_enhancer
// 的输入契约一致),alpha 通道原样透传。
cv::Mat CorrectExposureRgba(const cv::Mat& img_rgba, double target = 128.0,
                             double strength = 0.6);

}  // namespace ai_service::output

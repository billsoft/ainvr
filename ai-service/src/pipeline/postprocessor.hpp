// 对应 Python pipeline/postprocessor.py:letterbox 坐标换算 + 手写 NMS。
// 故意不用 cv::dnn::NMSBoxes —— 平局裁决/浮点误差处理和这里的手写实现不
// 保证一致,换掉可能让检测结果微妙地和 Python 版对不上。
#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include "../output/result.hpp"
#include "scale_info.hpp"

namespace ai_service::pipeline {

using Box = std::array<double, 4>;  // 视上下文是 xyxy 还是 xywh

std::vector<Box> clip_boxes(std::vector<Box> boxes, int w, int h);

// ⚠️ xyxy2xywh 和 xywh2xyxy 不是互逆函数,这是 Python 源码里就有的、故意
// 的不对称,不是移植失误(排查过一次,教训写在这里免得又踩):
// - xyxy2xywh 产出"左上角 x,y + 宽高"(Detection.bbox 对外的坐标约定),
//   给每个 adapter 在 postprocess 收尾时把最终 xyxy 转成公开格式用。
// - xywh2xyxy 假设输入是"中心点 cx,cy + 宽高"(标准 YOLO 模型原始输出格
//   式),只有 yolo26_traditional.py 用,在 NMS 之前把模型原始输出转 xyxy。
// 调用方传错格式不会报错,只会算出无意义的坐标——这是当前 Python 版本
// 本身的行为,C++ 移植原样保留,没有加防御性校验。
std::vector<Box> xyxy2xywh(const std::vector<Box>& boxes_xyxy);
std::vector<Box> xywh2xyxy(const std::vector<Box>& boxes_xywh);

// 把模型输出坐标系(letterbox 后)的 bbox 还原到原始图像坐标系,并裁剪到
// 原图范围内。
std::vector<Box> scale_boxes(const std::vector<Box>& boxes_xyxy,
                              const ScaleInfo& scale_info);

// 纯 CPU NMS,返回保留的索引(按置信度降序访问顺序,不是索引数值排序)。
//
// ⚠️ numpy 的 argsort 默认(quicksort)不是稳定排序,分数出现精确相等的
// 极少数场景下,C++ 这里用 stable_sort 打平的顺序可能和 Python 版不完全
// 一致——不影响最终保留的检测框集合语义,只影响并列同分时具体留哪一个
// 副本,这是移植过程中主动接受、没有消掉的差异,不是漏做。
std::vector<int64_t> nms(const std::vector<Box>& boxes_xyxy,
                          const std::vector<double>& scores, double iou_th);

// 把 Detection 列表从 "AI 采样分辨率坐标系" 换算到 "真实源分辨率坐标系"。
// scale_x==1.0 且 scale_y==1.0 时是纯 no-op。
std::vector<Detection> rescale_detections(const std::vector<Detection>& detections,
                                           double scale_x, double scale_y);

}  // namespace ai_service::pipeline

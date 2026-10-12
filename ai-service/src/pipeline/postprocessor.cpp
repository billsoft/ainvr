#include "postprocessor.hpp"

#include <algorithm>
#include <numeric>

namespace ai_service::pipeline {

std::vector<Box> clip_boxes(std::vector<Box> boxes, int w, int h) {
  for (auto& b : boxes) {
    b[0] = std::clamp(b[0], 0.0, static_cast<double>(w));
    b[1] = std::clamp(b[1], 0.0, static_cast<double>(h));
    b[2] = std::clamp(b[2], 0.0, static_cast<double>(w));
    b[3] = std::clamp(b[3], 0.0, static_cast<double>(h));
  }
  return boxes;
}

std::vector<Box> xyxy2xywh(const std::vector<Box>& boxes_xyxy) {
  std::vector<Box> out(boxes_xyxy.size());
  for (size_t i = 0; i < boxes_xyxy.size(); ++i) {
    const auto& b = boxes_xyxy[i];
    out[i] = {b[0], b[1], b[2] - b[0], b[3] - b[1]};
  }
  return out;
}

std::vector<Box> xywh2xyxy(const std::vector<Box>& boxes_xywh) {
  std::vector<Box> out(boxes_xywh.size());
  for (size_t i = 0; i < boxes_xywh.size(); ++i) {
    const auto& b = boxes_xywh[i];
    out[i] = {b[0] - b[2] / 2.0, b[1] - b[3] / 2.0, b[0] + b[2] / 2.0,
              b[1] + b[3] / 2.0};
  }
  return out;
}

std::vector<Box> scale_boxes(const std::vector<Box>& boxes_xyxy,
                              const ScaleInfo& si) {
  std::vector<Box> orig(boxes_xyxy.size());
  for (size_t i = 0; i < boxes_xyxy.size(); ++i) {
    const auto& b = boxes_xyxy[i];
    orig[i] = {(b[0] - si.pad_left) / si.scale, (b[1] - si.pad_top) / si.scale,
               (b[2] - si.pad_left) / si.scale, (b[3] - si.pad_top) / si.scale};
  }
  return clip_boxes(std::move(orig), si.orig_w, si.orig_h);
}

std::vector<int64_t> nms(const std::vector<Box>& boxes, const std::vector<double>& scores,
                          double iou_th) {
  size_t n = boxes.size();
  if (n == 0) return {};

  std::vector<int64_t> order(n);
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(),
                    [&](int64_t a, int64_t b) { return scores[a] > scores[b]; });

  std::vector<double> areas(n);
  for (size_t i = 0; i < n; ++i) {
    areas[i] = (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]);
  }

  std::vector<int64_t> keep;
  std::vector<int64_t> remaining = order;

  while (!remaining.empty()) {
    int64_t i = remaining[0];
    keep.push_back(i);
    if (remaining.size() == 1) break;

    std::vector<int64_t> next_remaining;
    next_remaining.reserve(remaining.size() - 1);
    for (size_t k = 1; k < remaining.size(); ++k) {
      int64_t j = remaining[k];
      double xx1 = std::max(boxes[i][0], boxes[j][0]);
      double yy1 = std::max(boxes[i][1], boxes[j][1]);
      double xx2 = std::min(boxes[i][2], boxes[j][2]);
      double yy2 = std::min(boxes[i][3], boxes[j][3]);
      double w = std::max(0.0, xx2 - xx1);
      double h = std::max(0.0, yy2 - yy1);
      double inter = w * h;
      double iou = inter / (areas[i] + areas[j] - inter);
      if (iou <= iou_th) next_remaining.push_back(j);
    }
    remaining = std::move(next_remaining);
  }
  return keep;
}

std::vector<Detection> rescale_detections(const std::vector<Detection>& detections,
                                           double scale_x, double scale_y) {
  if (scale_x == 1.0 && scale_y == 1.0) return detections;
  std::vector<Detection> rescaled;
  rescaled.reserve(detections.size());
  for (const auto& d : detections) {
    Detection nd = d;
    nd.bbox = {d.bbox[0] * scale_x, d.bbox[1] * scale_y, d.bbox[2] * scale_x,
               d.bbox[3] * scale_y};
    if (d.landmarks) {
      std::vector<std::array<double, 2>> lm;
      lm.reserve(d.landmarks->size());
      for (const auto& p : *d.landmarks) {
        lm.push_back({p[0] * scale_x, p[1] * scale_y});
      }
      nd.landmarks = std::move(lm);
    }
    rescaled.push_back(std::move(nd));
  }
  return rescaled;
}

}  // namespace ai_service::pipeline

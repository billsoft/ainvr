// 对应 Python output/result.py —— Detection + FrameResult。
// FrameResult::ToDict() 的输出形状是 /api/v1/channels/{id}/results 系列
// 接口响应体的一部分(外部 API 契约),字段名/嵌套结构/round() 位数必须
// 精确复刻,不能"按意图重新设计"。
#pragma once

#include <array>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>  // model_extra 是值成员,需要完整类型

namespace ai_service {

struct Detection {
  int class_id = 0;
  std::string class_name;
  double confidence = 0.0;
  std::array<double, 4> bbox{0, 0, 0, 0};  // (x, y, w, h) 原图坐标系
  // 5 点人脸关键点 [(x,y), ...],只有 scrfd_trt 填充;其余模型 nullopt
  // (不是空 vector —— 两者语义不同,详见 Python sei.py _det_json 的注释)
  std::optional<std::vector<std::array<double, 2>>> landmarks;
  bool confidence_known = true;
  std::string label_id;
  std::string track_id;  // Session-qualified object identity, never a label ID.
  std::string query_description;
  nlohmann::json model_extra = nlohmann::json::object();
};

// 单帧推理结果(公共信封)。schema_version "1.2":detections[].landmarks
// 是相对 1.1 新增的可选字段,不影响老消费者。
struct FrameResult {
  std::string schema_version = "1.2";
  std::string channel_id;
  std::string stream_url;
  std::string stream_protocol;
  double timestamp = 0.0;   // 系统 Unix 时间戳(秒)
  int64_t frame_pts_ns = 0;  // 视频帧 PTS(纳秒)
  int64_t frame_index = 0;
  int frame_width = 0;
  int frame_height = 0;

  std::string model_name;
  std::string model_format = "hbm";
  std::string model_provider = "bpu";
  std::vector<int> model_input_size;
  bool model_end2end = false;
  std::string model_version = "1.0";

  double time_decode_ms = 0.0;
  double time_preprocess_ms = 0.0;
  double time_inference_ms = 0.0;
  double time_postprocess_ms = 0.0;

  std::string task_type = "object_detection";
  std::vector<Detection> detections;
  nlohmann::json model_extra = nlohmann::json::object();

  double TotalTimeMs() const {
    return time_decode_ms + time_preprocess_ms + time_inference_ms + time_postprocess_ms;
  }

  // 序列化为 JSON 友好的形状,与 Python FrameResult.to_dict() 逐字段对齐
  // (见 docs/v1_parity_design.md §3.3a)。
  nlohmann::json ToDict() const;
};

}  // namespace ai_service

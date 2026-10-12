// FrameResult::ToDict() 精确形状测试(§3.3a):字段名、嵌套结构、
// landmarks 条件性出现、round() 位数,逐条对照 Python FrameResult.to_dict()。
#include <gtest/gtest.h>

#include "../../src/output/result.hpp"

using ai_service::Detection;
using ai_service::FrameResult;

TEST(FrameResult, OpenVocabularyDoesNotInventConfidence) {
  FrameResult result;
  result.schema_version = "1.3";
  Detection detection;
  detection.class_name = "成年女性";
  detection.label_id = "woman";
  detection.confidence_known = false;
  result.detections.push_back(detection);
  auto item = result.ToDict()["detections"][0];
  EXPECT_TRUE(item["confidence"].is_null());
  EXPECT_EQ(item["label_id"], "woman");
}

TEST(FrameResult, ToDictTopLevelShape) {
  FrameResult r;
  r.channel_id = "cam01";
  r.stream_url = "rtmp://x/live/y";
  r.stream_protocol = "rtmp";
  r.timestamp = 1700000000.123456;
  r.frame_pts_ns = 1316343000000;
  r.frame_index = 42;
  r.frame_width = 1920;
  r.frame_height = 1080;
  r.model_name = "yolo26m";
  r.model_format = "engine";
  r.model_provider = "tensorrt";
  r.model_input_size = {640, 640};
  r.model_end2end = true;
  r.time_preprocess_ms = 1.234;
  r.time_inference_ms = 5.678;
  r.time_postprocess_ms = 0.5;
  r.task_type = "object_detection";

  auto j = r.ToDict();
  EXPECT_EQ(j["schema_version"], "1.2");
  EXPECT_EQ(j["channel_id"], "cam01");
  EXPECT_EQ(j["stream_url"], "rtmp://x/live/y");
  EXPECT_EQ(j["stream_protocol"], "rtmp");
  EXPECT_DOUBLE_EQ(j["timestamp"].get<double>(), 1700000000.123);  // round 3 位
  EXPECT_EQ(j["frame_pts_ns"], 1316343000000LL);
  EXPECT_EQ(j["frame_index"], 42);
  EXPECT_EQ(j["frame_width"], 1920);
  EXPECT_EQ(j["frame_height"], 1080);

  EXPECT_EQ(j["model"]["name"], "yolo26m");
  EXPECT_EQ(j["model"]["format"], "engine");
  EXPECT_EQ(j["model"]["provider"], "tensorrt");
  EXPECT_EQ(j["model"]["input_size"], (std::vector<int>{640, 640}));
  EXPECT_EQ(j["model"]["end2end"], true);
  EXPECT_EQ(j["model"]["version"], "1.0");

  EXPECT_DOUBLE_EQ(j["timing_ms"]["preprocess"].get<double>(), 1.23);
  EXPECT_DOUBLE_EQ(j["timing_ms"]["inference"].get<double>(), 5.68);
  EXPECT_DOUBLE_EQ(j["timing_ms"]["postprocess"].get<double>(), 0.5);
  EXPECT_DOUBLE_EQ(j["timing_ms"]["total"].get<double>(), 7.41);  // 1.234+5.678+0.5, round 2 位

  EXPECT_EQ(j["task_type"], "object_detection");
  EXPECT_TRUE(j["detections"].is_array());
  EXPECT_TRUE(j["detections"].empty());
  EXPECT_EQ(j["model_extra"], nlohmann::json::object());
}

TEST(FrameResult, DetectionWithoutLandmarksOmitsKey) {
  FrameResult r;
  Detection d;
  d.class_id = 0;
  d.class_name = "person";
  d.confidence = 0.987654;
  d.bbox = {10.111, 20.222, 30.333, 40.444};
  r.detections.push_back(d);

  auto j = r.ToDict();
  ASSERT_EQ(j["detections"].size(), 1u);
  const auto& dj = j["detections"][0];
  EXPECT_EQ(dj["class_id"], 0);
  EXPECT_EQ(dj["class_name"], "person");
  EXPECT_DOUBLE_EQ(dj["confidence"].get<double>(), 0.9877);  // round 4 位
  EXPECT_DOUBLE_EQ(dj["bbox"]["x"].get<double>(), 10.11);    // round 2 位
  EXPECT_DOUBLE_EQ(dj["bbox"]["y"].get<double>(), 20.22);
  EXPECT_DOUBLE_EQ(dj["bbox"]["w"].get<double>(), 30.33);
  EXPECT_DOUBLE_EQ(dj["bbox"]["h"].get<double>(), 40.44);
  EXPECT_FALSE(dj.contains("landmarks"));  // 关键:无关键点时这个 key 不能出现
}

TEST(FrameResult, DetectionWithLandmarksIncludesKey) {
  FrameResult r;
  Detection d;
  d.class_id = 0;
  d.class_name = "face";
  d.confidence = 0.5;
  d.bbox = {0, 0, 10, 10};
  d.landmarks = std::vector<std::array<double, 2>>{
      {1.111, 2.222}, {3.0, 4.0}, {5.0, 6.0}, {7.0, 8.0}, {9.0, 10.0}};
  r.detections.push_back(d);

  auto j = r.ToDict();
  const auto& dj = j["detections"][0];
  ASSERT_TRUE(dj.contains("landmarks"));
  ASSERT_EQ(dj["landmarks"].size(), 5u);
  EXPECT_DOUBLE_EQ(dj["landmarks"][0]["x"].get<double>(), 1.11);
  EXPECT_DOUBLE_EQ(dj["landmarks"][0]["y"].get<double>(), 2.22);
}

TEST(FrameResult, TotalTimeMsSumsAllStages) {
  FrameResult r;
  r.time_decode_ms = 1.0;
  r.time_preprocess_ms = 2.0;
  r.time_inference_ms = 3.0;
  r.time_postprocess_ms = 4.0;
  EXPECT_DOUBLE_EQ(r.TotalTimeMs(), 10.0);
}

// Python round(0.125, 2) == 0.12(0.125 在二进制下精确,平局取偶);
// std::round 会得到 0.13。result 的 ToDict 是对外契约,必须同 v1。
TEST(FrameResult, RoundingMatchesPythonHalfToEven) {
  FrameResult r;
  Detection d;
  d.class_name = "x";
  d.confidence = 0.00125;  // 4 位 → 0.0012(平局取偶)
  d.bbox = {0.125, 0.375, 2.5, 10.0};
  r.detections.push_back(d);
  auto j = r.ToDict();
  auto& b = j["detections"][0]["bbox"];
  EXPECT_DOUBLE_EQ(b["x"].get<double>(), 0.12);
  EXPECT_DOUBLE_EQ(b["y"].get<double>(), 0.38);
  EXPECT_DOUBLE_EQ(j["detections"][0]["confidence"].get<double>(), 0.0012);
}

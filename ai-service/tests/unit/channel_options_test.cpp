// Copyright AINVR.
#include "pipeline/channel_options.hpp"
#include <gtest/gtest.h>
static ai_service::config::ChannelConfig Config() {
  ai_service::config::ChannelConfig c;c.id="camera";
  c.stream.url="http://127.0.0.1:8080/live/camera.flv";c.stream.protocol="flv";
  c.model.provider="cpu";c.model.adapter="yolo26_end2end";c.model.path="models/yolo26m.onnx";
  return c;
}
TEST(ChannelOptions, PreservesConfiguredExecutionValues) {
  auto c=Config();c.inference_fps=3;c.postprocess.conf_threshold=.7;
  c.preprocess.padding_color={1,2,3};c.result_buffer.max_frames=8;
  auto o=ainvr::OnnxOptions(c,"/home/sunrise/ainvr/ai-service");
  EXPECT_EQ(o.id,c.id);EXPECT_EQ(o.url,c.stream.url);EXPECT_EQ(o.inference_fps,3);
  EXPECT_EQ(o.processor.detection.confidence,.7);EXPECT_EQ(o.result_capacity,8);
  EXPECT_EQ(o.processor.preprocess.padding_color,c.preprocess.padding_color);
  EXPECT_EQ(o.processor.classes.size(),80);EXPECT_EQ(o.processor.classes[0],"person");
  EXPECT_EQ(o.processor.model_path,"/home/sunrise/ainvr/ai-service/models/yolo26m.onnx");
  EXPECT_EQ((*o.processor.expected_input_size)[0],640);
}
TEST(ChannelOptions, DoesNotInventTransportOrIgnoreProtocol) {
  auto c=Config();c.stream.url="rtmp://camera/live/a?token=example";c.stream.protocol="auto";
  EXPECT_EQ(ainvr::OnnxOptions(c,"/models").url,c.stream.url);
  c.stream.protocol="flv";EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
}
TEST(ChannelOptions, DoesNotStartStoppedOrDeletingChannels) {
  auto c=Config();c.enabled=false;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
  c=Config();c.manually_stopped=true;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
  c=Config();c.deletion_pending=true;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
}
TEST(ChannelOptions, NeverDisguisesMissingExecutionBackends) {
  auto c=Config();c.model.provider="bpu";EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
  c=Config();c.publish.enabled=true;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
  c=Config();c.snapshot.enabled=true;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
  c=Config();c.stream.reconnect.backoff_factor=3;EXPECT_THROW(ainvr::OnnxOptions(c,"/models"),std::invalid_argument);
}

// Copyright AINVR.
#include "config/config.hpp"
#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
using namespace ai_service::config;
using nlohmann::json;
namespace {
json Channel(){return {{"id","test"},{"stream",{{"url","rtmp://localhost/live/test"}}}};}
}
TEST(S100pConfig, NativeBpuAndOnnxContracts){
  for(const auto& adapter:{"yolo26_bpu","yoloface_bpu","scrfd_bpu"}){
    auto ch=Channel();ch["model"]={{"adapter",adapter},{"provider","bpu"},{"path","models/model.hbm"}};
    auto parsed=ChannelConfigFromJson(ch);EXPECT_EQ(ChannelConfigToJson(parsed)["model"]["provider"],"bpu");
    ch["model"]["path"]="models/model.engine";EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
    ch["model"]["path"]="models/model.onnx";EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
    ch["model"]["provider"]="cpu";EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
  }
  auto ch=Channel();ch["model"]={{"adapter","yolo26_end2end"},{"provider","cpu"},{"path","models/model.onnx"}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}
TEST(S100pConfig, NeverSilentlyConvertsJetsonConfiguration){
  for(const auto& provider:{"cuda","tensorrt"}){
    auto ch=Channel();ch["model"]={{"provider",provider}};EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
  }
  for(const auto& adapter:{"yolo26_trt","yoloface_trt","scrfd_trt","locateanything_trt","yoloe_pt"}){
    auto ch=Channel();ch["model"]={{"adapter",adapter}};EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
  }
}

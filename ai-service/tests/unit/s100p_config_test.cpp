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

TEST(S100pConfig, MultiPromptLabelsRoundTripAndRejectInvalidIdentity) {
  auto ch=Channel();ch["model"]={{"adapter","yoloe_bpu"},{"provider","bpu"},{"path","models/yoloe.hbm"},
    {"prompts",json::array({{{"description","person"},{"label_id","person"},{"label_name","People"}},
                          {{"description","hard hat"},{"label_id","helmet"},{"label_name","Helmet"}}})}};
  auto parsed=ChannelConfigFromJson(ch);ASSERT_EQ(parsed.model.prompts.size(),2u);
  EXPECT_EQ(ChannelConfigToJson(parsed)["model"]["prompts"],ch["model"]["prompts"]);
  auto bad=ch;bad["model"]["prompts"][1]["label_id"]="person";
  EXPECT_THROW(ChannelConfigFromJson(bad),ConfigValidationError);
  bad=ch;bad["model"]["prompts"][0]["description"]="";
  EXPECT_THROW(ChannelConfigFromJson(bad),ConfigValidationError);
  bad=ch;bad["model"]["prompts"]=json::array();
  EXPECT_THROW(ChannelConfigFromJson(bad),ConfigValidationError);
  bad=ch;bad["model"]["adapter"]="yolo26_bpu";
  EXPECT_THROW(ChannelConfigFromJson(bad),ConfigValidationError);
}

TEST(S100pConfig, PromptSlotLimitsAndSwitchToClosedModel) {
  auto ch=Channel();ch["model"]={{"adapter","yoloe_bpu"},{"provider","bpu"},{"name","yoloe-26x"},{"path","models/yoloe.hbm"}};
  auto rows=json::array();
  for(int i=0;i<8;++i) rows.push_back({{"description","object "+std::to_string(i)},
    {"label_id","id"+std::to_string(i)},{"label_name","Object "+std::to_string(i)}});
  ch["model"]["prompts"]=rows;
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
  for(int i=8;i<32;++i) rows.push_back({{"description","object "+std::to_string(i)},
    {"label_id","id"+std::to_string(i)},{"label_name","Object "+std::to_string(i)}});
  ch["model"]["prompts"]=rows;
  EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
  ch["model"]["name"]="yoloe-26x-32";
  EXPECT_EQ(ChannelConfigFromJson(ch).model.prompts.size(),32u);
  ch["model"]["prompts"].push_back({{"description","extra"},{"label_id","extra"},{"label_name","Extra"}});
  EXPECT_THROW(ChannelConfigFromJson(ch),ConfigValidationError);
  ch["model"]["prompts"]=nullptr;
  ch["model"]["adapter"]="yolo26_bpu";
  ch["model"]["name"]="yolo26x";
  EXPECT_TRUE(ChannelConfigFromJson(ch).model.prompts.empty());
}

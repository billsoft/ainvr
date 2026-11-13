// Copyright AINVR. Contract/config tests are software-only, no model loading.
#include "adapters/pose_contract.hpp"
#include "adapters/bpu_contract_ports.hpp"
#include "adapters/runtime_label_catalog.hpp"
#include <gtest/gtest.h>
using nlohmann::json;
using namespace ai_service;
using namespace ai_service::adapters;
namespace {
config::ModelConfig Config() {
  config::ModelConfig cfg;cfg.adapter=kPoseAdapter;cfg.name="human-pose-yolo26s";
  cfg.path="models/human-pose-yolo26s.hbm";cfg.provider="bpu";
  cfg.input_size={640,640};cfg.class_names=std::vector<std::string>{"person"};return cfg;
}
json Contract() {
  return {{"schema_version",1},{"target","rdk_s100p"},{"adapter",nullptr},
    {"adapter_planned",kPoseAdapter},{"task","pose"},{"input_contract","float_nchw_rgb"},
    {"output_contract",kInstalledPoseOutputContract},{"class_names",{"person"}},
    {"preprocess",{{"rgb_order",true},{"normalize","/255"},{"letterbox",{{"size",640},{"fill",114},{"center",true}}}}},
    {"keypoints",{{"count",17},{"layout","COCO order, each (x, y, visibility score)"}}},
    {"inputs",{{"images",{{"shape",{1,3,640,640}},{"dtype","hbDNNDataType.F32"}}}}},
    {"outputs",{{"output0",{{"shape",{1,300,57}},{"dtype","hbDNNDataType.F32"}}}}},
    {"hbm_sha256",std::string(64,'a')},{"hbm_bytes",19153304},
    {"accuracy_verified",false},{"production_approved",false}};
}
json Channel() {
  return {{"id","pose-test"},{"stream",{{"url","rtmp://127.0.0.1/live/test"}}},
      {"model",{{"adapter",kPoseAdapter},{"name","human-pose-yolo26s"},{"path","models/human-pose-yolo26s.hbm"},
        {"provider","bpu"},{"input_size",{640,640}},{"class_names",{"person"}}}}};
}
}
TEST(PoseContract, NormalizesInstalledObjectContractWithoutChangingSourceOrApprovals) {
  const auto source=Contract(),saved=source;
  const auto m=NormalizePoseContract(Config(),source);
  EXPECT_EQ(source,saved);EXPECT_TRUE(source["adapter"].is_null());
  EXPECT_EQ(m["adapter"],kPoseAdapter);EXPECT_EQ(m["input_size"],json::array({640,640}));
  EXPECT_EQ(m["outputs"][0]["shape"],json::array({1,300,57}));
  EXPECT_EQ(m["preprocess"]["std"],json::array({255,255,255}));
  EXPECT_EQ(m["accuracy_verified"],false);EXPECT_EQ(m["production_approved"],false);
}
TEST(BpuContractPorts, NormalizesCocoNamedMapsWithoutChangingSourceOrApprovals) {
  auto cfg=Config();cfg.adapter="yolo26_bpu";
  auto source=Contract();source["adapter"]=cfg.adapter;source["input_contract"]="float_nchw";
  source["output_contract"]="end2end_xyxy_score_class";source["outputs"]["output0"]["shape"]={1,300,6};
  const auto saved=source;auto result=NormalizeDetectorPortMaps(cfg,source);
  EXPECT_EQ(source,saved);EXPECT_EQ(result["outputs"][0]["name"],"output0");
  EXPECT_EQ(result["outputs"][0]["dtype_id"],7);EXPECT_EQ(result["production_approved"],false);
  EXPECT_EQ(NormalizeDetectorPortMaps(cfg,result),result); // old arrays unchanged
  auto actual=result["outputs"][0];EXPECT_NO_THROW(ValidateDeclaredSdkPort(result["outputs"][0],actual));
  actual["dtype_id"]=3;EXPECT_ANY_THROW(ValidateDeclaredSdkPort(result["outputs"][0],actual));
  const std::vector<std::pair<std::string,json>> changes={
    {"/outputs/output0/shape",json::array({1,299,6})},
    {"/outputs/output0/dtype","hbDNNDataType.S8"},{"/outputs/output0/name","different"},
    {"/inputs/images/shape",json::array({1,640,640,3})},
    {"/inputs/images/quantization",1},{"/inputs/images/dtype_id",7.5},
  };
  for(const auto& [path,value]:changes) {
    auto m=source;m[json::json_pointer(path)]=value;SCOPED_TRACE(path);
    EXPECT_ANY_THROW(NormalizeDetectorPortMaps(cfg,m));
  }
  source["outputs"]["unexpected"]=source["outputs"]["output0"];
  EXPECT_ANY_THROW(NormalizeDetectorPortMaps(cfg,source));
}
TEST(PoseContract, AcceptsEquivalentExplicitArrayPortsButRejectsWrongBoundaries) {
  auto m=Contract();
  m["inputs"]=json::array({{{"name","images"},{"shape",{1,3,640,640}},{"dtype_id",7},{"quantization",0}}});
  m["outputs"]=json::array({{{"name","output0"},{"shape",{1,300,57}},{"dtype_id",7},{"quantization",0}}});
  EXPECT_NO_THROW(NormalizePoseContract(Config(),m));
  m["outputs"][0]["quantization"]=1;EXPECT_ANY_THROW(NormalizePoseContract(Config(),m));
  m["outputs"][0]["quantization"]=0;m["outputs"][0]["dtype_id"]=3;
  EXPECT_ANY_THROW(NormalizePoseContract(Config(),m));
}
TEST(PoseContract, RejectsUnrelatedNullAdaptersAndSemanticOrPreprocessMismatch) {
  const std::vector<std::pair<std::string,json>> changes={
    {"/adapter_planned","embedding_bpu"},{"/adapter","yolo26_bpu"},{"/target","other"},
    {"/task","detect"},{"/class_names",json::array({"face"})},{"/keypoints/count",5},
    {"/keypoints/layout","unknown"},{"/input_contract","float_nchw"},
    {"/output_contract","end2end_xyxy_score_class"},{"/preprocess/normalize",true},
    {"/preprocess/rgb_order",false},{"/preprocess/letterbox/center",false},
    {"/preprocess/letterbox/fill",0},{"/inputs/images/dtype","hbDNNDataType.S8"},
    {"/outputs/output0/shape",json::array({1,300,6})},
    {"/inputs/images/shape",json::array({1,640,640,3})},
  };
  for(const auto& [path,value]:changes) {
    auto m=Contract();m[json::json_pointer(path)]=value;
    SCOPED_TRACE(path);EXPECT_ANY_THROW(NormalizePoseContract(Config(),m));
  }
  auto cfg=Config();cfg.input_size={320,320};EXPECT_ANY_THROW(NormalizePoseContract(cfg,Contract()));
}
TEST(PoseContract, ConfigAllowsPoseButFailsClosedForWrongRootOrNodePreprocessing) {
  auto c=Channel();EXPECT_NO_THROW(config::ChannelConfigFromJson(c));
  c["preprocess"]={{"rgb_order",false}};
  EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
  c=Channel();c["model"]["class_names"]={"face"};EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
  c=Channel();c["model"]["input_size"]={320,320};EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
  auto extra=Channel()["model"];
  c=Channel();c["model"]["adapter"]="yolo26_bpu";
  c["analysis_pipeline"]={{"execution","serial"},{"nodes",json::array({{{"id","pose"},{"model",extra},
    {"preprocess",{{"padding_color",{0,0,0}}}}}})}};
  EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
  c["analysis_pipeline"]["nodes"][0]["preprocess"]=json::object();
  EXPECT_NO_THROW(config::ChannelConfigFromJson(c));
}
TEST(PoseContract, CatalogKeepsPersonIdentityAndAdvertisesVersionedAttribute) {
  const auto catalog=RuntimeLabelCatalog(Config(),{"person"});
  ASSERT_EQ(catalog["labels"].size(),1u);EXPECT_EQ(catalog["labels"][0]["label_id"],"class:0");
  EXPECT_EQ(catalog["attributes"]["pose"]["count"],17);
  auto cfg=Config();cfg.adapter="yolo26_bpu";
  EXPECT_FALSE(RuntimeLabelCatalog(cfg,{"person"}).contains("attributes"));
}
TEST(PoseContract, PreservesLegacyAndPoseDetectionLimitsForRootAndExtraNodes) {
  for(const char* adapter:{"yolo26_bpu","scrfd_bpu",kPoseAdapter}) {
    auto c=Channel();c["model"]["adapter"]=adapter;
    if(std::string(adapter)=="scrfd_bpu")c["model"]["class_names"]={"face"};
    for(int limit:{1,300,1000}) {
      c["postprocess"]={{"max_detections",limit}};
      SCOPED_TRACE(std::string(adapter)+" root="+std::to_string(limit));
      EXPECT_NO_THROW(config::ChannelConfigFromJson(c));
    }
    for(int limit:{0,-1,1001}) {
      c["postprocess"]["max_detections"]=limit;EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
    }
    c["postprocess"]["max_detections"]=1;
    c["analysis_pipeline"]={{"execution","serial"},{"nodes",json::array({
      {{"id","extra"},{"model",c["model"]},{"postprocess",{{"max_detections",999}}}}})}};
    EXPECT_NO_THROW(config::ChannelConfigFromJson(c));
    for(int limit:{0,-1,1001}) {
      c["analysis_pipeline"]["nodes"][0]["postprocess"]["max_detections"]=limit;
      EXPECT_ANY_THROW(config::ChannelConfigFromJson(c));
    }
  }
}

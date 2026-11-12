#include "config/config.hpp"
#include "config/config_store.hpp"
#include <gtest/gtest.h>
using namespace ai_service::config;
using nlohmann::json;

json Base(){ChannelConfig c;
c.id="test";
c.postprocess.max_detections=300;
c.model.adapter="yolo26_bpu";
c.model.provider="bpu";
c.model.path="models/a.hbm";
c.model.input_size={640,640};
c.stream.url="rtmp://127.0.0.1:1935/live/source";
return ChannelConfigToJson(c);
}
TEST(PipelineConfig,LegacyChannelRemainsSingleModel){auto c=ChannelConfigFromJson(Base());
EXPECT_TRUE(c.analysis_nodes.empty());
EXPECT_FALSE(ChannelConfigToJson(c).contains("analysis_pipeline"));
}
TEST(PipelineConfig,ExplicitEmptyGraphSurvivesToDisableLegacyIntent){auto j=Base();
j["analysis_pipeline"]={{"execution","serial"},{"nodes",json::array()}};
auto c=ChannelConfigFromJson(j);
EXPECT_TRUE(c.analysis_pipeline_present);
EXPECT_EQ(ChannelConfigToJson(c)["analysis_pipeline"],j["analysis_pipeline"]);
}
TEST(PipelineConfig,RejectsDuplicatesAndUnboundedGraphs){auto j=Base();
auto n=json{{"id","face"},{"model",j["model"]},{"postprocess",{{"max_detections",300}}}};
j["analysis_pipeline"]={{"execution","parallel"},{"nodes",json::array({n})}};
auto c=ChannelConfigFromJson(j);
EXPECT_EQ(c.analysis_nodes.size(),1);
EXPECT_EQ(ChannelConfigFromJson(ChannelConfigToJson(c)).analysis_nodes[0].id,"face");
j["analysis_pipeline"]["nodes"].push_back(n);
EXPECT_THROW(ChannelConfigFromJson(j),std::exception);
j["analysis_pipeline"]["nodes"]=json::array();
j["analysis_pipeline"]["execution"]="unbounded";
EXPECT_THROW(ChannelConfigFromJson(j),std::exception);
}

TEST(PipelineConfig,ModelOrderIsAnExactPermutation){auto j=Base();auto n=json{{"id","face"},{"model",j["model"]}};j["analysis_pipeline"]={{"execution","serial"},{"nodes",json::array({n})},{"order",{"face","primary"}}};auto c=ChannelConfigFromJson(j);EXPECT_EQ(ChannelConfigToJson(c)["analysis_pipeline"]["order"],j["analysis_pipeline"]["order"]);j["analysis_pipeline"]["order"]={"face","face"};
EXPECT_THROW(ChannelConfigFromJson(j),std::exception);j["analysis_pipeline"]["order"]={"face"};
EXPECT_THROW(ChannelConfigFromJson(j),std::exception);j["analysis_pipeline"]["order"]={"face","missing"};
EXPECT_THROW(ChannelConfigFromJson(j),std::exception);}
TEST(PipelineConfig,DeletingImportedModelPreservesRemainingIdentity){auto j=Base();j["analysis_pipeline"]={{"execution","serial"},{"root_id","face"},{"nodes",json::array()},{"order",{"face"}}};auto c=ChannelConfigFromJson(j);EXPECT_TRUE(c.UsesAnalysisPipeline());EXPECT_EQ(c.analysis_root_id,"face");EXPECT_EQ(ChannelConfigToJson(c)["analysis_pipeline"],j["analysis_pipeline"]);}

TEST(PipelineConfig,ReplacingGraphClearsDeletedIdentityAndOrder) {
  auto old = Base();
  old["analysis_pipeline"] = {{"root_id", "plate"}, {"order", {"plate"}},
      {"execution", "serial"}, {"nodes", json::array()}};
  auto node = json{{"id", "plate"}, {"model", old["model"]}};
  json patch = {{"analysis_pipeline", {{"execution", "parallel"},
      {"nodes", json::array({node})}}}};
  auto merged = DeepMerge(old, patch);
  EXPECT_EQ(merged["analysis_pipeline"], patch["analysis_pipeline"]);
  auto config = ChannelConfigFromJson(merged);
  EXPECT_EQ(config.analysis_root_id, "primary");
  EXPECT_TRUE(config.analysis_order.empty());
  EXPECT_EQ(config.analysis_nodes.size(), 1);
  // Unrelated partial edits preserve the whole graph.
  EXPECT_EQ(DeepMerge(merged, {{"name", "renamed"}})["analysis_pipeline"],
            merged["analysis_pipeline"]);
}

TEST(PipelineConfig,RejectsCombinedDetectionBudgetBeforeSave) {
  auto j=Base();json nodes=json::array();
  for(const auto* id:{"a","b","c"})nodes.push_back({{"id",id},{"model",j["model"]},{"postprocess",{{"max_detections",300}}}});
  j["analysis_pipeline"]={{"nodes",nodes},{"execution","parallel"}};
  EXPECT_THROW(ChannelConfigFromJson(j),std::exception);
  j["postprocess"]["max_detections"]=250;
  for(auto& node:j["analysis_pipeline"]["nodes"])node["postprocess"]["max_detections"]=250;
  EXPECT_NO_THROW(ChannelConfigFromJson(j));
}

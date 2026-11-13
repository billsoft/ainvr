#include "adapters/pipeline_limits.hpp"
#include "adapters/base_adapter.hpp"
#include "adapters/pipeline_merge.hpp"
#include <gtest/gtest.h>
using namespace ai_service;using namespace ai_service::adapters;
auto Catalog(std::string name,std::string id="class:0",std::string description=""){return nlohmann::json{{"labels",nlohmann::json::array({{{"class_id",0},{"label_id",id},{"name",name},{"description",description}}})}};}
TEST(PipelineMerge,SameLocalClassDoesNotMergeDifferentObjects){PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("face",Catalog("face"),true);Detection d;d.class_id=0;auto p=l.Map("primary",{d}),f=l.Map("face",{d});EXPECT_EQ(p[0].label_id,"class:0");EXPECT_NE(p[0].class_id,f[0].class_id);EXPECT_EQ(f[0].label_id,"node:face:class:0");EXPECT_EQ(l.Catalog()["labels"].size(),2);}
TEST(PipelineMerge,DuplicateSemanticLabelHasOneOwner){PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("other",Catalog("person"),true);Detection d;d.class_id=0;EXPECT_EQ(l.Map("primary",{d}).size(),1);EXPECT_TRUE(l.Map("other",{d}).empty());}
TEST(PipelineMerge,PromptIdentityRequiresSameMeaning){PipelineLabels l;l.Add("primary",Catalog("包","bag","red bag"),false);EXPECT_THROW(l.Add("other",Catalog("包","bag","blue bag"),false),std::runtime_error);EXPECT_EQ(l.Catalog()["labels"][0]["description"],"red bag");}
TEST(PipelineMerge,UnknownOutputCannotBecomePerson){PipelineLabels l;l.Add("primary",Catalog("person"),true);Detection d;d.class_id=4;EXPECT_THROW(l.Map("primary",{d}),std::runtime_error);}
TEST(PipelineMerge,AttributesRemainAttachedToSource){PipelineLabels l;l.Add("primary",Catalog("license_plate","plate"),true);Detection d;d.class_id=0;d.bbox={10,20,30,40};d.model_extra["attributes"]={{"plate_text",{{"value","测试"}}}};auto out=l.Map("primary",{d});EXPECT_EQ(out[0].bbox,d.bbox);EXPECT_EQ(out[0].model_extra["attributes"],d.model_extra["attributes"]);EXPECT_EQ(out[0].model_extra["source_node"],"primary");}

TEST(PipelineMerge,PriorityChangesOwnerWithoutChangingLabelIdentity){PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("other",Catalog("person"),true);auto before=l.Catalog();l.SetPriority({"other","primary"});Detection d;d.class_id=0;EXPECT_TRUE(l.Map("primary",{d}).empty());auto out=l.Map("other",{d});ASSERT_EQ(out.size(),1);EXPECT_EQ(out[0].label_id,"class:0");EXPECT_EQ(out[0].class_id,0);EXPECT_EQ(out[0].model_extra["source_node"],"other");EXPECT_EQ(l.Catalog()["labels"][0]["label_id"],before["labels"][0]["label_id"]);l.SetPriority({"primary","other"});EXPECT_TRUE(l.Map("other",{d}).empty());EXPECT_EQ(l.Map("primary",{d}).size(),1);}
TEST(PipelineMerge,NoLegacyModelRequired){PipelineLabels l;l.Add("face",Catalog("face"),true);l.SetPriority({"face"});Detection d;d.class_id=0;auto out=l.Map("face",{d});ASSERT_EQ(out.size(),1);EXPECT_EQ(out[0].label_id,"node:face:class:0");}

TEST(PipelineLimits,TrackingCandidatesShareBoundedSpareWithoutCrossModelScores) {
  auto q=ai_service::adapters::PipelineCandidateLimits({300,300,300});
  EXPECT_EQ(q,(std::vector<int>{334,333,333}));
  EXPECT_EQ(ai_service::adapters::PipelineCandidateLimits({250,250,250,250}),(std::vector<int>{250,250,250,250}));
  EXPECT_EQ(ai_service::adapters::PipelineCandidateLimits({100}),(std::vector<int>{1000}));
  EXPECT_THROW(ai_service::adapters::PipelineCandidateLimits({300,300,300,300}),std::invalid_argument);
}
TEST(PipelineLimits,PlateGeometryIsCheckedBeforeDispatch) {
  using ai_service::adapters::PlateSourceSupported;
  EXPECT_TRUE(PlateSourceSupported(3840,2160));
  EXPECT_FALSE(PlateSourceSupported(7680,4320));
  EXPECT_FALSE(PlateSourceSupported(1921,1080));
  EXPECT_FALSE(PlateSourceSupported(0,0));
}
class TaskHintProbe:public ai_service::adapters::BaseModelAdapter {
 public:void Load(const std::string&,const std::string&,const std::string&)override{}
 std::string ActualProvider()const override{return "test";}
};
TEST(PipelineTask,ArtifactNameCannotMakeHelmetModelAFaceTask) {
  TaskHintProbe helmet;helmet.ApplyTaskTypeHint({"helmet","no_helmet"},"helmet-face-yolo26s","face/model.hbm");
  EXPECT_EQ(helmet.TaskType(),"object_detection");
  TaskHintProbe face;face.ApplyTaskTypeHint({"face"},"renamed","model.hbm");
  EXPECT_EQ(face.TaskType(),"face_detection");
}

static Detection Person(double x=0,double y=0,double w=100,double h=100){Detection d;d.class_id=0;d.bbox={x,y,w,h};return d;}
TEST(PipelineFusion,PoseSurvivesNonOwnerWithoutDuplicatingPeople){
  PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("pose",Catalog("person"),true);
  auto person=Person(),pose=Person(1,1);pose.model_extra["attributes"]["pose"]={{"schema_version",1},{"points",nlohmann::json::array({{2,3,.9}})}};
  auto result=l.Merge({{"primary",{person}},{"pose",{pose}}});
  ASSERT_EQ(result.detections.size(),1);EXPECT_EQ(result.detections[0].bbox,person.bbox);
  EXPECT_EQ(result.detections[0].model_extra["source_node"],"primary");
  EXPECT_EQ(result.detections[0].model_extra["attributes"]["pose"]["source_node"],"pose");
  EXPECT_TRUE(result.unassociated.empty());
  l.SetPriority({"pose","primary"});auto reversed=l.Merge({{"primary",{person}},{"pose",{pose}}});
  ASSERT_EQ(reversed.detections.size(),1);EXPECT_EQ(reversed.detections[0].label_id,result.detections[0].label_id);
  EXPECT_TRUE(reversed.detections[0].model_extra["attributes"].contains("pose"));
}
TEST(PipelineFusion,AmbiguousCrowdDoesNotBorrowAnotherPersonsPose){
  PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("pose",Catalog("person"),true);
  auto pose=Person(5);pose.model_extra["attributes"]["pose"]={{"schema_version",1}};
  auto result=l.Merge({{"primary",{Person(),Person(10)}},{"pose",{pose}}});
  ASSERT_EQ(result.detections.size(),2);EXPECT_FALSE(result.detections[0].model_extra.contains("attributes"));
  ASSERT_EQ(result.unassociated.size(),1);EXPECT_EQ(result.unassociated[0]["association"],"unknown");
}
TEST(PipelineFusion,ReciprocalGateRejectsMergedOrDuplicatedTargets){
  PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("pose",Catalog("person"),true);
  auto pose=Person();pose.model_extra["attributes"]["pose"]={{"schema_version",1}};
  auto result=l.Merge({{"primary",{Person()}},{"pose",{pose,pose}}});
  EXPECT_FALSE(result.detections[0].model_extra.contains("attributes"));EXPECT_EQ(result.unassociated.size(),2);
}
TEST(PipelineFusion,MissingOwnerNeverCreatesExtraTrackedPerson){
  PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("pose",Catalog("person"),true);
  auto pose=Person();pose.model_extra["attributes"]["pose"]={{"schema_version",1}};
  auto result=l.Merge({{"primary",{}},{"pose",{pose}}});
  EXPECT_TRUE(result.detections.empty());EXPECT_EQ(result.unassociated.size(),1);
}
TEST(PipelineFusion,AttributesAndUnassociatedEvidenceHaveExplicitBudgets){
  PipelineLabels l;l.Add("primary",Catalog("person"),true);l.Add("pose",Catalog("person"),true);
  auto pose=Person();pose.model_extra["attributes"]["pose"]={{"payload",std::string(2049,'x')}};
  auto result=l.Merge({{"primary",{Person()}},{"pose",{pose}}});
  EXPECT_EQ(result.omitted,1);EXPECT_FALSE(result.detections[0].model_extra.contains("attributes"));
  pose.model_extra["attributes"]["pose"]={{"schema_version",1}};
  result=l.Merge({{"primary",{}},{"pose",std::vector<Detection>(40,pose)}});
  EXPECT_EQ(result.unassociated.size(),32);EXPECT_EQ(result.omitted,8);
}

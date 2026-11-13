// Copyright AINVR. Software-only pose decoder tests, no neural inference.
#include "adapters/detection_decode.hpp"
#include "model_capabilities_probe_checks.hpp"
#include <gtest/gtest.h>
#include <algorithm>
#include <limits>
using namespace ainvr;
namespace {
const std::string hash(64,'a');
DenseTensor PoseTensor() {
  DenseTensor t{"output0",{1,300,57},std::vector<float>(300*57,0)};
  t.values[0]=100;t.values[1]=200;t.values[2]=300;t.values[3]=400;t.values[4]=.9f;
  for(int k=0;k<17;++k) {
    t.values[6+k*3]=120+k;t.values[7+k*3]=220+k;t.values[8+k*3]=.8f;
  }
  return t;
}
auto Scale(){return ai_service::pipeline::compute_scale(1280,720,640,640);}
}
TEST(PoseDecode, RestoresAllCoco17PointsToOriginalPixelsWithoutFaceLandmarks) {
  const auto out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  ASSERT_EQ(out.size(),1u);
  EXPECT_EQ(out[0].class_name,"person");EXPECT_EQ(out[0].class_id,0);
  EXPECT_FALSE(out[0].landmarks);
  EXPECT_EQ(out[0].bbox,(std::array<double,4>{200,120,400,400}));
  const auto& pose=out[0].model_extra.at("attributes").at("pose");
  EXPECT_EQ(pose.at("schema_version"),"1.0");EXPECT_EQ(pose.at("layout"),"coco17");
  EXPECT_EQ(pose.at("coordinate_space"),"original_image");
  EXPECT_EQ(pose.at("source_model_sha256"),hash);
  ASSERT_EQ(pose.at("points").size(),17u);
  for(int k=0;k<17;++k) {
    EXPECT_EQ(pose.at("points")[k].at("x"),240+2*k);
    EXPECT_EQ(pose.at("points")[k].at("y"),160+2*k);
    EXPECT_NEAR(pose.at("points")[k].at("score").get<double>(),.8,1e-4);
  }
}
TEST(CapabilitiesProbe, ChecksAllSourcePointsWithoutClampingAndReportsEmptyEvidence) {
  auto out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  auto check=[&] {return capabilities_probe::CheckDetections(out,1280,720,{"person"},true,hash);};
  EXPECT_EQ(check()["points_checked"],17);EXPECT_EQ(check()["source_coordinate_bounds_valid"],true);
  out[0].model_extra["attributes"]["pose"]["points"][16]["x"]=-1;
  EXPECT_EQ(check()["points_outside_source"],1);EXPECT_EQ(check()["source_coordinate_bounds_valid"],false);
  EXPECT_EQ(out[0].model_extra["attributes"]["pose"]["points"][16]["x"],-1);
  out.clear();EXPECT_EQ(check()["nonempty_detections"],false);
}
TEST(CapabilitiesProbe, RejectsNonFiniteWrongSourceOrIncompleteSkeleton) {
  auto out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  auto check=[&] {return capabilities_probe::CheckDetections(out,1280,720,{"person"},true,hash);};
  out[0].bbox[0]=std::numeric_limits<double>::infinity();EXPECT_ANY_THROW(check());
  out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  out[0].model_extra["attributes"]["pose"]["points"][16]["score"]=std::numeric_limits<double>::quiet_NaN();
  EXPECT_ANY_THROW(check());
  out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  out[0].model_extra["attributes"]["pose"]["source_model_sha256"]=std::string(64,'b');EXPECT_ANY_THROW(check());
  out=DecodeYolo26Pose(PoseTensor(),Scale(),hash);
  out[0].model_extra["attributes"]["pose"]["points"].erase(16);EXPECT_ANY_THROW(check());
}
TEST(PoseDecode, ConfidenceOrderingMaximumAndNoSecondNms) {
  auto t=PoseTensor();std::copy_n(t.values.begin(),57,t.values.begin()+57);
  t.values[4]=.7f;
  const auto out=DecodeYolo26Pose(t,Scale(),hash);
  ASSERT_EQ(out.size(),2u);EXPECT_NEAR(out[0].confidence,.9,1e-6);
  EXPECT_EQ(DecodeYolo26Pose(t,Scale(),hash,{.25,.45,1}).size(),1u);
  EXPECT_TRUE(DecodeYolo26Pose(t,Scale(),hash,{.95,.45,300}).empty());
}
TEST(PoseDecode, DoesNotInventVisiblePointsOrSnapHiddenPointsToImageEdges) {
  auto t=PoseTensor();t.values[6]=-12;t.values[7]=20;t.values[8]=.1f;
  const auto pose=DecodeYolo26Pose(t,Scale(),hash)[0].model_extra["attributes"]["pose"];
  EXPECT_EQ(pose["points"][0]["x"],-24);EXPECT_EQ(pose["points"][0]["y"],-240);
  EXPECT_EQ(pose["points"][0]["score"],0);
  EXPECT_EQ(pose["points"][0]["visible"],0);
  EXPECT_EQ(pose["visibility_threshold"],.5);
}
TEST(PoseDecode, InvalidatesHighConfidencePaddingAndOffImageJointsWithoutClamping) {
  auto t=PoseTensor();
  t.values[6]=-12;t.values[6+3]=650;
  t.values[7+2*3]=100;t.values[7+3*3]=600;
  const auto out=DecodeYolo26Pose(t,Scale(),hash);
  const auto& p=out[0].model_extra["attributes"]["pose"]["points"];
  ASSERT_EQ(p.size(),17u);
  for(int k=0;k<4;++k) {EXPECT_EQ(p[k]["score"],0);EXPECT_EQ(p[k]["visible"],0);}
  EXPECT_EQ(p[0]["x"],-24);EXPECT_EQ(p[1]["x"],1300);
  EXPECT_EQ(p[2]["y"],-80);EXPECT_EQ(p[3]["y"],920);
  EXPECT_NEAR(p[4]["score"].get<double>(),.8,1e-4);EXPECT_EQ(p[4]["visible"],1);
  const auto checked=capabilities_probe::CheckDetections(out,1280,720,{"person"},true,hash);
  EXPECT_EQ(checked["points_outside_source"],4);EXPECT_EQ(checked["invalid_points"],4);
  EXPECT_EQ(checked["valid_points_outside_source"],0);EXPECT_EQ(checked["source_coordinate_bounds_valid"],true);
}
TEST(PoseDecode, RejectsWrongShapeNonFiniteClassesProbabilitiesAndTransform) {
  for(const auto& shape:std::vector<std::vector<int64_t>>{{300,57},{1,300,6},{1,300,56},{1,57,300},{2,300,57}}) {
    auto t=PoseTensor();t.shape=shape;EXPECT_THROW(DecodeYolo26Pose(t,Scale(),hash),std::invalid_argument);
  }
  auto t=PoseTensor();t.values.pop_back();EXPECT_THROW(DecodeYolo26Pose(t,Scale(),hash),std::invalid_argument);
  for(int index:{4,6,7,8,57+8}) {
    t=PoseTensor();t.values[index]=std::numeric_limits<float>::quiet_NaN();
    EXPECT_THROW(DecodeYolo26Pose(t,Scale(),hash),std::invalid_argument);
  }
  for(int index:{4,8,57+8}) {
    t=PoseTensor();t.values[index]=1.1f;EXPECT_THROW(DecodeYolo26Pose(t,Scale(),hash),std::invalid_argument);
  }
  for(float id:{-1.f,1.f,.5f}) {
    t=PoseTensor();t.values[5]=id;EXPECT_THROW(DecodeYolo26Pose(t,Scale(),hash),std::invalid_argument);
  }
  auto scale=Scale();scale.pad_top=0;
  EXPECT_THROW(DecodeYolo26Pose(PoseTensor(),scale,hash),std::invalid_argument);
  EXPECT_THROW(DecodeYolo26Pose(PoseTensor(),Scale(),""),std::invalid_argument);
}
TEST(PoseDecode, KeepsCompleteSkeletonUnderSeiBudgetAtLargeImageSizes) {
  auto t=PoseTensor();
  for(int k=0;k<17;++k) {
    t.values[6+k*3]=500.12345f+k;t.values[7+k*3]=400.98765f-k;t.values[8+k*3]=.9876543f;
  }
  auto scale=ai_service::pipeline::compute_scale(16384,8192,640,640);
  const auto out=DecodeYolo26Pose(t,scale,hash);
  ASSERT_EQ(out.size(),1u);
  EXPECT_EQ(out[0].model_extra["attributes"]["pose"]["points"].size(),17u);
  EXPECT_LE(out[0].model_extra["attributes"].dump().size(),2048u);
  EXPECT_FALSE(out[0].landmarks);
}
TEST(PoseDecode, LegacyEndToEndAndScrfdDoNotBecomePose) {
  DenseTensor t{"output0",{1,1,6},{1,2,10,20,.9f,0}};
  auto out=DecodeEndToEnd(t,Scale(),{"person"});ASSERT_EQ(out.size(),1u);
  EXPECT_FALSE(out[0].model_extra.contains("attributes"));EXPECT_FALSE(out[0].landmarks);
  EXPECT_THROW(DecodeEndToEnd(PoseTensor(),Scale(),{"person"}),std::invalid_argument);
  std::vector<DenseTensor> heads;
  for(int stride:{8,16,32})for(int columns:{1,4,10}) {
    const int anchors=(64/stride)*(64/stride)*2;
    heads.push_back({"head",{1,anchors,columns},std::vector<float>(anchors*columns,0)});
  }
  heads[0].values[18]=.9f;
  for(int j=0;j<4;++j)heads[1].values[18*4+j]=1;
  out=DecodeScrfd(heads,ai_service::pipeline::compute_scale(64,64,64,64));
  ASSERT_EQ(out.size(),1u);ASSERT_TRUE(out[0].landmarks);
  EXPECT_EQ(out[0].landmarks->size(),5u);EXPECT_FALSE(out[0].model_extra.contains("attributes"));
}

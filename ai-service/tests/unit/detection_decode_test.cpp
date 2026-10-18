// Copyright AINVR.
#include "adapters/detection_decode.hpp"
#include <gtest/gtest.h>
#include <algorithm>
#include <limits>
using namespace ainvr;
namespace {
std::vector<DenseTensor> Outputs(){
  std::vector<DenseTensor> out;
  for(int stride:{8,16,32})for(int cols:{1,4,10}){int n=64/stride*(64/stride)*2;out.push_back({"head",{1,n,cols},std::vector<float>(n*cols,0)});}
  return out;
}
}
TEST(DetectionDecode, ScrfdAnchorPairsLandmarksAndLetterbox){
  auto out=Outputs();int anchor=(3*8+4)*2;out[0].values[anchor]=.9f;out[0].values[anchor+1]=.8f;
  for(int i:{anchor,anchor+1})for(int j=0;j<4;++j)out[1].values[i*4+j]=1;
  for(int k=0;k<5;++k){out[2].values[anchor*10+k*2]=.5f;out[2].values[anchor*10+k*2+1]=-.5f;}
  std::reverse(out.begin(),out.end());
  auto result=DecodeScrfd(out,ai_service::pipeline::compute_scale(128,64,64,64));
  ASSERT_EQ(result.size(),1);EXPECT_EQ(result[0].class_name,"face");
  EXPECT_EQ(result[0].bbox,(std::array<double,4>{48,0,32,32}));
  ASSERT_TRUE(result[0].landmarks);EXPECT_EQ(result[0].landmarks->at(0),(std::array<double,2>{72,8}));
}
TEST(DetectionDecode, RejectsWrongOrNonFiniteHeads){
  auto out=Outputs();auto scale=ai_service::pipeline::compute_scale(64,64,64,64);
  out[0].values[0]=std::numeric_limits<float>::quiet_NaN();EXPECT_THROW(DecodeScrfd(out,scale),std::invalid_argument);
  out=Outputs();out[0].values.pop_back();EXPECT_THROW(DecodeScrfd(out,scale),std::invalid_argument);
  out=Outputs();out[0]=out[1];EXPECT_THROW(DecodeScrfd(out,scale),std::invalid_argument);
}
TEST(DetectionDecode, EndToEndDoesNotApplySecondNms){
  DenseTensor tensor{"detections",{1,3,6},{10,20,30,40,.8f,1,10,20,30,40,.9f,0,0,0,0,0,0,0}};
  auto result=DecodeEndToEnd(tensor,ai_service::pipeline::compute_scale(64,64,64,64),{"person","car"});
  ASSERT_EQ(result.size(),2);EXPECT_EQ(result[0].class_name,"person");EXPECT_EQ(result[1].class_name,"car");
  tensor.values[5]=1.5f;EXPECT_THROW(DecodeEndToEnd(tensor,ai_service::pipeline::compute_scale(64,64,64,64),{"person","car"}),std::invalid_argument);
}
TEST(DetectionDecode, RawYoloeClassAwareNmsAndInactiveSlots){
  DenseTensor t{"boxes_scores",{1,12,3},std::vector<float>(12*3,0)};
  for(int i=0;i<3;++i){t.values[i]=30;t.values[3+i]=40;t.values[6+i]=20;t.values[9+i]=10;}
  t.values[12]=.9f;t.values[13]=.8f;t.values[14]=.1f;
  t.values[15]=.1f;t.values[16]=.1f;t.values[17]=.85f;
  // A padded class has a higher score but must not participate.
  t.values[18]=1;
  auto got=DecodeYoloeRaw(t,ai_service::pipeline::compute_scale(64,64,64,64),{"person","forklift"});
  ASSERT_EQ(got.size(),2u);EXPECT_EQ(got[0].class_name,"person");EXPECT_EQ(got[1].class_name,"forklift");
  EXPECT_EQ(got[0].bbox,(std::array<double,4>{20,35,20,10}));EXPECT_EQ(got[1].class_id,1);
}
TEST(DetectionDecode, RawYoloeRestoresLetterboxCoordinatesAndMaximum){
  DenseTensor t{"boxes_scores",{1,5,2},{32,10,32,20,16,4,8,4,.9f,.8f}};
  auto got=DecodeYoloeRaw(t,ai_service::pipeline::compute_scale(128,64,64,64),{"a worker in a safety vest"},{.25,.45,1});
  ASSERT_EQ(got.size(),1u);EXPECT_EQ(got[0].bbox,(std::array<double,4>{48,24,32,16}));
  EXPECT_EQ(got[0].class_name,"a worker in a safety vest");
}
TEST(DetectionDecode, RawYoloeUsesStableAnchorOrderForEqualScores){
  DenseTensor t{"boxes_scores",{1,6,2},{10,40,10,40,4,4,4,4,.1f,.5f,.5f,.1f}};
  auto got=DecodeYoloeRaw(t,ai_service::pipeline::compute_scale(64,64,64,64),{"car","person"});
  ASSERT_EQ(got.size(),2u);EXPECT_EQ(got[0].class_id,1);EXPECT_EQ(got[1].class_id,0);
}
TEST(DetectionDecode, RawYoloeRejectsBadSignaturesAndScores){
  DenseTensor t{"boxes_scores",{1,5,1},{10,10,4,4,.9f}};
  auto scale=ai_service::pipeline::compute_scale(64,64,64,64);
  EXPECT_THROW(DecodeYoloeRaw(t,scale,{}),std::invalid_argument);
  EXPECT_THROW(DecodeYoloeRaw(t,scale,{"a","b"}),std::invalid_argument);
  t.values[4]=1.01f;EXPECT_THROW(DecodeYoloeRaw(t,scale,{"a"}),std::invalid_argument);
  t.values[4]=std::numeric_limits<float>::quiet_NaN();EXPECT_THROW(DecodeYoloeRaw(t,scale,{"a"}),std::invalid_argument);
  t.values[4]=.9f;t.shape={5,1};EXPECT_THROW(DecodeYoloeRaw(t,scale,{"a"}),std::invalid_argument);
}

TEST(DetectionDecode, RawYoloeThirtyTwoSlots) {
  DenseTensor t{"boxes_scores",{1,36,1},std::vector<float>(36,0)};
  t.values[0]=30;t.values[1]=40;t.values[2]=20;t.values[3]=10;
  t.values[4+31]=.9f;t.values[4+8]=.7f;
  std::vector<std::string> names;for(int i=0;i<32;++i)names.push_back("slot"+std::to_string(i));
  auto scale=ai_service::pipeline::compute_scale(64,64,64,64);
  auto got=DecodeYoloeRaw(t,scale,names);
  ASSERT_EQ(got.size(),1u);EXPECT_EQ(got[0].class_id,31);EXPECT_EQ(got[0].class_name,"slot31");
  names.resize(9);got=DecodeYoloeRaw(t,scale,names);
  ASSERT_EQ(got.size(),1u);EXPECT_EQ(got[0].class_id,8);
  names.resize(8);EXPECT_TRUE(DecodeYoloeRaw(t,scale,names).empty());
}

TEST(DetectionDecode, ProbabilityRoundoffDoesNotDiscardValidFrame) {
  const auto before=GetDetectionDecodeStats();
  DenseTensor t{"detections",{1,3,6},{10,10,20,20,1.0001f,0,0,0,0,0,-.00001f,0,30,30,40,40,.8f,0}};
  auto s=ai_service::pipeline::compute_scale(64,64,64,64);
  auto got=DecodeEndToEnd(t,s,{"person"});
  ASSERT_EQ(got.size(),2);EXPECT_EQ(got[0].confidence,1);
  EXPECT_EQ(GetDetectionDecodeStats().clamped_probabilities-before.clamped_probabilities,2u);
  t.values[4]=1.01f;EXPECT_THROW(DecodeEndToEnd(t,s,{"person"}),std::invalid_argument);
  t.values[4]=-.01f;EXPECT_THROW(DecodeEndToEnd(t,s,{"person"}),std::invalid_argument);
}
TEST(DetectionDecode, BadGeometrySkipsOnlyItsCandidate) {
  const auto before=GetDetectionDecodeStats();
  DenseTensor t{"detections",{1,3,6},{20,10,10,20,.9f,0,10,10,20,20,.8f,0,10,10,10,20,.7f,0}};
  auto s=ai_service::pipeline::compute_scale(64,64,64,64);
  auto got=DecodeEndToEnd(t,s,{"person"});ASSERT_EQ(got.size(),1);
  EXPECT_EQ(GetDetectionDecodeStats().rejected_geometry-before.rejected_geometry,2u);
  t.values[0]=std::numeric_limits<float>::quiet_NaN();
  EXPECT_THROW(DecodeEndToEnd(t,s,{"person"}),std::invalid_argument);
}
TEST(DetectionDecode, ScrfdDistanceRoundoffAndInvalidCandidateAreIsolated) {
  auto out=Outputs();auto s=ai_service::pipeline::compute_scale(64,64,64,64);
  const auto before=GetDetectionDecodeStats();
  for(int i:{18,40}){out[0].values[i]=.9f;for(int j=0;j<4;++j)out[1].values[i*4+j]=1;}
  out[1].values[18*4]=-.00001f;out[1].values[40*4]=-1;
  auto got=DecodeScrfd(out,s);ASSERT_EQ(got.size(),1);EXPECT_GT(got[0].bbox[2],0);
  EXPECT_EQ(GetDetectionDecodeStats().clamped_distances-before.clamped_distances,1u);
  EXPECT_EQ(GetDetectionDecodeStats().rejected_geometry-before.rejected_geometry,1u);
}
TEST(DetectionDecode, YoloeRoundoffAndBadGeometryDoNotPoisonOtherAnchors) {
  DenseTensor t{"boxes_scores",{1,5,3},{10,30,50,10,30,50,-1,4,4,4,4,4,1.0001f,.8f,-.00001f}};
  auto s=ai_service::pipeline::compute_scale(64,64,64,64);
  auto got=DecodeYoloeRaw(t,s,{"person"});ASSERT_EQ(got.size(),1);EXPECT_FLOAT_EQ(got[0].confidence,.8f);
  t.values[14]=std::numeric_limits<float>::infinity();
  EXPECT_THROW(DecodeYoloeRaw(t,s,{"person"}),std::invalid_argument);
}

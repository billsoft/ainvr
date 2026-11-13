#include "face_embedding_test_fixture.hpp"
#include <gtest/gtest.h>
#include <limits>
using namespace ainvr::face;
using namespace face_test;

TEST(FaceAlignment,IdentityAndPixelCenters) {
  auto m=FitSimilarity(kTemplate);EXPECT_NEAR(m.a,1,1e-12);EXPECT_NEAR(m.b,0,1e-12);EXPECT_NEAR(m.rms,0,1e-12);
  const auto uv=m.SourceUv(112,112);
  for(auto p:std::array<Point,4>{{{0,0},{111,0},{0,111},{31,77}}}){
    const double u=(p[0]+.5)/112,v=(p[1]+.5)/112;
    EXPECT_NEAR((uv[0]*u+uv[1]*v+uv[2])*112-.5,p[0],1e-5);
    EXPECT_NEAR((uv[3]*u+uv[4]*v+uv[5])*112-.5,p[1],1e-5);
  }
}
TEST(FaceAlignment,RecoversRotationScaleTranslationWithoutPixelProcessing) {
  Landmarks source;const double a=1.7*std::cos(.3),b=1.7*std::sin(.3);
  for(size_t i=0;i<5;++i)source[i]={a*kTemplate[i][0]-b*kTemplate[i][1]+73,b*kTemplate[i][0]+a*kTemplate[i][1]+21};
  auto m=FitSimilarity(source);auto uv=m.SourceUv(641,479);
  for(size_t i=0;i<5;++i){auto q=m.Forward(source[i]);EXPECT_NEAR(q[0],kTemplate[i][0],1e-9);EXPECT_NEAR(q[1],kTemplate[i][1],1e-9);
    const auto u=(q[0]+.5)/112,v=(q[1]+.5)/112;
    EXPECT_NEAR((uv[0]*u+uv[1]*v+uv[2])*641-.5,source[i][0],1e-4);
    EXPECT_NEAR((uv[3]*u+uv[4]*v+uv[5])*479-.5,source[i][1],1e-4);}
}
TEST(FaceAlignment,DegenerateAndNonfiniteAreRejected) {
  Landmarks points{};EXPECT_THROW(FitSimilarity(points),std::invalid_argument);
  points=kTemplate;points[2][0]=NAN;EXPECT_THROW(FitSimilarity(points),std::invalid_argument);
}
TEST(FaceQuality,GeometryGateDoesNotClaimBlurLivenessOrRecognition) {
  Similarity m;auto q=Assess(Face(),112,112,m);ASSERT_TRUE(q.accepted);
  EXPECT_FALSE(q.ToJson().at("blur_assessed").get<bool>());EXPECT_FALSE(q.ToJson().at("liveness_assessed").get<bool>());
  EXPECT_EQ(q.ToJson().at("scope"),"geometry_only");
}
TEST(FaceQuality,RejectsMissingPointsSmallFacesAndLowScore) {
  auto c=Face();Similarity m;c.has_landmarks=false;EXPECT_EQ(Assess(c,112,112,m).reason,"missing_five_landmarks");
  c=Face();c.box[2]=24;EXPECT_EQ(Assess(c,112,112,m).reason,"insufficient_face_pixels");
  c=Face();c.detection_score=.4;EXPECT_EQ(Assess(c,112,112,m).reason,"low_detection_score");
}
TEST(FaceQuality,RejectsMirrorAndOffImageCrop) {
  auto c=Face();Similarity m;for(auto& p:c.landmarks)p[0]=111-p[0];EXPECT_FALSE(Assess(c,112,112,m).accepted);
  c=Face();for(auto& p:c.landmarks)p[0]-=10;EXPECT_EQ(Assess(c,112,112,m).reason,"alignment_crop_outside");
}
TEST(FaceQuality,RejectsMalformedAndNonrigidPoints) {
  auto c=Face();Similarity m;c.landmarks[0][0]=NAN;EXPECT_FALSE(Assess(c,112,112,m).accepted);
  c=Face();c.landmarks[2][1]-=25;EXPECT_EQ(Assess(c,112,112,m).reason,"alignment_residual");
}
TEST(FaceEmbedding,NormalizationIsL2NotProbability) {
  std::vector<float> raw(512,0);raw[0]=-3;raw[1]=4;auto out=Normalize(raw);
  EXPECT_NEAR(out[0],-.6,1e-6);EXPECT_NEAR(out[1],.8,1e-6);double norm=0;for(auto v:out)norm+=v*v;EXPECT_NEAR(norm,1,1e-6);
}
TEST(FaceEmbedding,RejectsZeroNonfiniteAndWrongDimensions) {
  EXPECT_THROW(Normalize(std::vector<float>(511,1)),std::invalid_argument);
  EXPECT_THROW(Normalize(std::vector<float>(512,0)),std::invalid_argument);
  auto v=std::vector<float>(512,1);v[7]=INFINITY;EXPECT_THROW(Normalize(v),std::invalid_argument);
}
TEST(FaceEmbedding,ModelSpaceSeparatesMbfAndR50AndIgnoresDisplayNotes) {
  auto a=Spec(),b=Spec("face-embed-r50");EXPECT_NE(SpaceHash(a),SpaceHash(b));
  b=a;b.manifest["note"]="renamed";EXPECT_EQ(SpaceHash(a),SpaceHash(b));
  EXPECT_TRUE(IsHash(SpaceHash(a)));
}
TEST(FaceManifest,AcceptsInstalledNullAdapterButRejectsWrongRgbAndShape) {
  auto s=Spec();EXPECT_NO_THROW(ParseManifest(s.id,s.path,s.manifest,true));
  auto m=s.manifest;m["preprocess"]["rgb_order"]=false;EXPECT_THROW(ParseManifest(s.id,s.path,m,true),std::invalid_argument);
  m=s.manifest;m["outputs"]["516"]["shape"]={1,256};EXPECT_THROW(ParseManifest(s.id,s.path,m,true),std::invalid_argument);
  m=s.manifest;m["preprocess"]["normalize"]="(x-127.5)/128";EXPECT_THROW(ParseManifest(s.id,s.path,m,true),std::invalid_argument);
}
TEST(FaceManifest,DemandIsAdditiveAndDisabledDemandDoesNotLoad) {
  Settings s;s.enabled=true;s.detector=Spec("face-det-scrfd-500m",false);s.embedding=Spec();
  Demand d{{"existing.hbm:",{"channel:one"}}};AppendDemand(d,s);ASSERT_EQ(d.size(),3);
  EXPECT_TRUE(d.at("existing.hbm:").contains("channel:one"));AppendDemand(d,s);EXPECT_EQ(d.size(),3);
  Demand empty;s.enabled=false;AppendDemand(empty,s);EXPECT_TRUE(empty.empty());
}
TEST(FacePrivacy,PublicSerializationNeverIncludesVectorsOrProbability) {
  Result r;r.status="extracted";r.quality.accepted=true;r.embedding[0]=1;
  EXPECT_TRUE(r.InternalJson().contains("embedding"));EXPECT_FALSE(r.PublicJson().contains("embedding"));
  EXPECT_FALSE(r.PublicJson().contains("probability"));EXPECT_FALSE(r.PublicJson().contains("identity"));
  r.status="quality_rejected";EXPECT_FALSE(r.InternalJson().contains("embedding"));
  r.status="extracted";r.quality.accepted=false;EXPECT_FALSE(r.InternalJson().contains("embedding"));
}

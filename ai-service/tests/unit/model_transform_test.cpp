// Copyright AINVR.
#include "pipeline/model_transform.hpp"
#include <gtest/gtest.h>
using ai_service::pipeline::PreprocessConfig;
TEST(ModelTransform, ModelDefaultsFollowModelFamily) {
  PreprocessConfig cfg;
  auto yolo=ainvr::ModelTransform(cfg,false), face=ainvr::ModelTransform(cfg,true);
  EXPECT_EQ(yolo.mean[0],0); EXPECT_EQ(yolo.divisor[0],255);
  EXPECT_EQ(face.mean[0],127.5); EXPECT_EQ(face.divisor[0],128);
}
TEST(ModelTransform, ExplicitNormalizationAndColorArePreserved) {
  PreprocessConfig cfg; cfg.normalization_explicit=true;
  cfg.mean={1,2,3};cfg.std={4,5,6};cfg.rgb_order=false;
  cfg.padding_color={10,20,30};cfg.interpolation="nearest";
  auto t=ainvr::ModelTransform(cfg,true);
  EXPECT_TRUE(t.bgr);EXPECT_TRUE(t.nearest);
  for(int i=0;i<3;++i){EXPECT_EQ(t.mean[i],i+1);EXPECT_EQ(t.divisor[i],i+4);EXPECT_EQ(t.padding[i],(i+1)*10);}
}
TEST(ModelTransform, DisabledNormalizationLeavesByteValues) {
  PreprocessConfig cfg;cfg.normalization_explicit=true;cfg.normalize=false;
  auto t=ainvr::ModelTransform(cfg,true);
  EXPECT_EQ(t.mean[0],0);EXPECT_EQ(t.divisor[0],1);
}
TEST(ModelTransform, UnsupportedGeometryDoesNotSilentlyUseDefaults) {
  PreprocessConfig cfg;cfg.letterbox=false;
  EXPECT_THROW(ainvr::ModelTransform(cfg,false),std::invalid_argument);
  cfg.letterbox=true;cfg.interpolation="area";
  EXPECT_THROW(ainvr::ModelTransform(cfg,false),std::invalid_argument);
}
TEST(ModelTransform, RejectsInvalidNumbersBeforeModelLoad) {
  PreprocessConfig cfg;cfg.normalization_explicit=true;cfg.std[0]=0;
  EXPECT_THROW(ainvr::ModelTransform(cfg,false),std::invalid_argument);
  cfg.std[0]=1;cfg.mean[1]=std::numeric_limits<double>::infinity();
  EXPECT_THROW(ainvr::ModelTransform(cfg,false),std::invalid_argument);
  cfg.mean[1]=0;cfg.padding_color[2]=256;
  EXPECT_THROW(ainvr::ModelTransform(cfg,false),std::invalid_argument);
}

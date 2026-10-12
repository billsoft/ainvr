#include "platform/gles_preprocess.hpp"
#include <gtest/gtest.h>
#include <cmath>
TEST(Gles, IdentityAndNormalization) {
  ainvr::GlesPreprocessor gpu; ainvr::ImageTransform t;
  t.width=3;t.height=2;t.letterbox=false;
  std::vector<uint8_t> pixels={10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255,130,140,150,255,160,170,180,255};
  auto out=gpu.Run(pixels,3,2,t);
  ASSERT_EQ(out.size(),18u);
  for(int c=0;c<3;++c)for(int i=0;i<6;++i)EXPECT_NEAR(out[c*6+i],pixels[i*4+c]/255.f,0.0001f);
  t.bgr=true;t.mean={1,2,3};t.divisor={2,4,8};out=gpu.Run(pixels,3,2,t);
  for(int c=0;c<3;++c)for(int i=0;i<6;++i)EXPECT_NEAR(out[c*6+i],(pixels[i*4+2-c]-t.mean[c])/t.divisor[c],0.02f);
}
TEST(Gles, BilinearAndLetterbox) {
  ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;
  t.width=1;t.height=1;t.letterbox=false;
  auto out=gpu.Run({0,0,0,255,100,100,100,255,200,200,200,255,240,240,240,255},2,2,t);
  EXPECT_NEAR(out[0],135.f/255,0.005);
  t.width=4;t.height=4;t.letterbox=true;
  out=gpu.Run({255,0,0,255,255,0,0,255},2,1,t);
  EXPECT_NEAR(out[0],114.f/255,0.0001);EXPECT_NEAR(out[4],1,0.0001);
  EXPECT_NEAR(out[12],114.f/255,0.0001);
}
TEST(Gles, ERPConstantAndValidation) {
  ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;t.width=4;t.height=4;t.erp_perspective=true;
  std::vector<uint8_t> input(8*4*4,128);auto out=gpu.Run(input,8,4,t);
  for(float x:out)EXPECT_NEAR(x,128.f/255,0.001);
  t.divisor[0]=0;EXPECT_THROW(gpu.Run(input,8,4,t),std::invalid_argument);
}
TEST(Gles, ERPAngleOrientation) {
  ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;
  t.width=1;t.height=1;t.erp_perspective=true;t.nearest=true;
  std::vector<uint8_t> input(8*4*4,255);
  for(int y=0;y<4;++y)for(int x=0;x<8;++x){input[(y*8+x)*4]=x*30;input[(y*8+x)*4+1]=y*60;}
  auto out=gpu.Run(input,8,4,t);EXPECT_NEAR(out[0],120.f/255,0.001);EXPECT_NEAR(out[1],120.f/255,0.001);
  t.yaw=1.57079632679f;t.pitch=0.78539816339f;
  out=gpu.Run(input,8,4,t);EXPECT_NEAR(out[0],180.f/255,0.001);EXPECT_NEAR(out[1],60.f/255,0.001);
}
TEST(Gles, Nv12LimitedAndFullRange) {
  ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;t.width=2;t.height=2;t.nearest=true;
  auto out=gpu.RunNv12({16,235,16,235,128,128},2,2,t);
  for(int c=0;c<3;++c){EXPECT_NEAR(out[c*4],0,0.001);EXPECT_NEAR(out[c*4+1],1,0.001);}
  t.yuv_full_range=true;out=gpu.RunNv12({0,255,0,255,128,128},2,2,t);
  for(int c=0;c<3;++c){EXPECT_NEAR(out[c*4],0,0.001);EXPECT_NEAR(out[c*4+1],1,0.001);}
  EXPECT_THROW(gpu.RunNv12({0,0,0},1,2,t),std::invalid_argument);
}

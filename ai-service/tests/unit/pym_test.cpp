// Copyright AINVR. Real PYM execution, including nonconstant content.
#include "platform/pym_scaler.hpp"
#include <gtest/gtest.h>
#include <chrono>
#include <array>
#include <iostream>
using namespace ainvr;
TEST(Pym, RejectsUnsupportedBeforeHardware){
  EXPECT_FALSE(PymScaler::Supports(7680,3840,3840,1920));
  EXPECT_FALSE(PymScaler::Supports(1920,1080,640,640));
  EXPECT_THROW(PymScaler(7680,3840,3840,1920),std::invalid_argument);
}
TEST(Pym, ConstantAndChangingFrames){
  // Actual model-sized, non-power-of-two reductions and square 4K input.
  for(auto dims: {std::array<int,4>{1920,1080,640,360},{3840,2160,640,360},{4096,4096,640,640}}){
    auto [w,h,ow,oh]=dims;PymScaler scaler(w,h,ow,oh);
    Nv12Frame input{w,h,0,std::vector<uint8_t>(size_t(w)*h*3/2)};
    auto begin=std::chrono::steady_clock::now();
    for(int frame=0;frame<8;++frame){
      int value=40+frame*20;input.pts=123+frame;
      std::fill(input.pixels.begin(),input.pixels.begin()+size_t(w)*h,value);
      std::fill(input.pixels.begin()+size_t(w)*h,input.pixels.end(),128);
      auto result=scaler.Run(input);ASSERT_EQ(result.pts,input.pts);
      ASSERT_EQ(result.width,ow);ASSERT_EQ(result.height,oh);
      for(size_t i=0;i<result.pixels.size();++i){int expected=i<size_t(ow)*oh?value:128;
        ASSERT_LE(std::abs(int(result.pixels[i])-expected),1)<<i;}
    }
    double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-begin).count();
    std::cout<<"PYM_COPY_AND_VALIDATE "<<w<<"x"<<h<<" -> "<<ow<<"x"<<oh<<" fps="<<8/seconds<<"\n";
  }
}
TEST(Pym, QuadrantsAndCodecLifetime){
  VpuDecoder decoder(Codec::H264,640,320);
  for(int pass=0;pass<2;++pass){
    PymScaler scaler(1920,1080,640,360);
    Nv12Frame input{1920,1080,42,std::vector<uint8_t>(1920*1080*3/2,128)};
    for(int y=0;y<1080;++y)for(int x=0;x<1920;++x)input.pixels[y*1920+x]=32+(x>=960?64:0)+(y>=540?128:0);
    auto output=scaler.Run(input);
    EXPECT_NEAR(output.pixels[90*640+160],32,1);
    EXPECT_NEAR(output.pixels[90*640+480],96,1);
    EXPECT_NEAR(output.pixels[270*640+160],160,1);
    EXPECT_NEAR(output.pixels[270*640+480],224,1);
  }
}

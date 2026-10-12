// Copyright AINVR.
#include "platform/gdc_projector.hpp"
#include <gtest/gtest.h>
#include <chrono>
#include <cmath>
#include <iostream>
using namespace ainvr;
TEST(Gdc, RejectsSeamPolesAndEightK){
  ImageTransform t;t.erp_perspective=true;t.width=640;t.height=360;
  EXPECT_TRUE(GdcProjector::Supports(3840,1920,t));
  EXPECT_FALSE(GdcProjector::Supports(7680,3840,t));
  t.yaw=3.14159265f;EXPECT_FALSE(GdcProjector::Supports(3840,1920,t));
  t.yaw=0;t.pitch=1.5;EXPECT_FALSE(GdcProjector::Supports(3840,1920,t));
}
TEST(Gdc, RealPerspectiveComparedWithGles){
  Nv12Frame input{1920,960,123,std::vector<uint8_t>(1920*960*3/2,128)};
  for(int y=0;y<960;++y)for(int x=0;x<1920;++x)input.pixels[y*1920+x]=std::lround(32+100.*x/1919+60.*y/959);
  for(int y=0;y<480;++y)for(int x=0;x<960;++x){input.pixels[1920*960+y*1920+x*2]=80+y/8;input.pixels[1920*960+y*1920+x*2+1]=80+x/12;}
  GlesPreprocessor gpu;ImageTransform t;t.erp_perspective=true;t.width=640;t.height=360;
  // Three different views require real map rebuilds. Color reference uses the
  // independent GLES projection, not the generated mesh.
  for(float yaw: {0.f,.7f,-1.2f}){
    t.yaw=yaw;t.pitch=.15f;GdcProjector gdc(1920,960,t);
    auto begin=std::chrono::steady_clock::now();Nv12Frame result;
    for(int i=0;i<12;++i){input.pts=123+i;result=gdc.Run(input);ASSERT_EQ(result.pts,input.pts);}
    double milliseconds=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count()/12;
    auto expected=gpu.RunNv12(input.pixels,input.width,input.height,t);
    ImageTransform plain=t;plain.erp_perspective=false;plain.letterbox=false;
    auto actual=gpu.RunNv12(result.pixels,result.width,result.height,plain);
    ASSERT_EQ(actual.size(),expected.size());double sum=0;float maximum=0;
    for(size_t i=0;i<actual.size();++i){float error=std::abs(actual[i]-expected[i])*255;sum+=error;maximum=std::max(maximum,error);}
    EXPECT_LT(sum/actual.size(),1.5);EXPECT_LT(maximum,5);
    std::cout<<"GDC_PERSPECTIVE yaw="<<yaw<<" map_and_setup_ms="<<gdc.ConfigurationMilliseconds()<<" copy_process_ms="<<milliseconds<<" mae="<<sum/actual.size()<<" max="<<maximum<<"\n";
  }
}

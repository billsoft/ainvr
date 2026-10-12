// Copyright AINVR.
#include "platform/image_preprocessor.hpp"
#include "platform/cpu_preprocess.hpp"
#include <gtest/gtest.h>
#include <cstdlib>
using namespace ainvr;
TEST(ImagePreprocessor, HardwarePriorityAndLetterbox){
  ImagePreprocessor processor;ImageTransform transform;
  Nv12Frame input{1920,1080,1,std::vector<uint8_t>(1920*1080*3/2,128)};
  auto output=processor.RunNv12(input,transform);
  EXPECT_EQ(output.backend,"pym+gles-color");ASSERT_EQ(output.chw.size(),640*640*3);
  EXPECT_NEAR(output.chw[0],114.f/255,0.003);
  EXPECT_NEAR(output.chw[320*640+320],(128.f-16)/219,0.006);
  transform.nearest=true;
  EXPECT_EQ(processor.RunNv12(input,transform).backend,"gles");
  transform.nearest=false;transform.erp_perspective=true;
  EXPECT_EQ(processor.RunNv12(input,transform).backend,"gdc+gles-color");
  auto reused=processor.RunNv12(input,transform);EXPECT_EQ(reused.gdc_configuration_ms,0);
  transform.yaw=3.14f;EXPECT_EQ(processor.RunNv12(input,transform).backend,"gles");
}
TEST(ImagePreprocessor, EightKUsesGles){
  ImagePreprocessor processor;ImageTransform transform;
  transform.width=640;transform.height=320;transform.letterbox=false;
  Nv12Frame input{7680,3840,2,std::vector<uint8_t>(size_t(7680)*3840*3/2,128)};
  auto output=processor.RunNv12(input,transform);EXPECT_EQ(output.backend,"gles");
  ASSERT_EQ(output.chw.size(),640*320*3);
  EXPECT_NEAR(output.chw[160*640+320],(128.f-16)/219,0.006);
}
TEST(ImagePreprocessor, CpuReferenceMatchesGpuIncludingSeam){
  ImagePreprocessor cpu({false,false,true}),gpu({false,true});
  Nv12Frame input{640,320,0,std::vector<uint8_t>(640*320*3/2)};
  for(int y=0;y<320;++y)for(int x=0;x<640;++x)input.pixels[y*640+x]=32+x/8+y/4;
  for(int y=0;y<160;++y)for(int x=0;x<320;++x){input.pixels[640*320+y*640+x*2]=80+y/2;input.pixels[640*320+y*640+x*2+1]=80+x/4;}
  for(int mode=0;mode<5;++mode){
    ImageTransform t;t.width=192;t.height=192;t.erp_perspective=mode>=2;t.yaw=3.14f;t.pitch=.1f;
    t.nearest=mode==1;t.yuv_bt709=mode!=3;t.yuv_full_range=mode==4;t.bgr=mode==4;
    auto actual=cpu.RunNv12(input,t),expected=gpu.RunNv12(input,t);
    EXPECT_EQ(actual.backend,"cpu");EXPECT_EQ(expected.backend,"gles");ASSERT_EQ(actual.chw.size(),expected.chw.size());
    double sum=0;float maximum=0;
    for(size_t i=0;i<actual.chw.size();++i){float delta=std::abs(actual.chw[i]-expected.chw[i])*255;sum+=delta;maximum=std::max(maximum,delta);}
    EXPECT_LT(sum/actual.chw.size(),.5)<<mode;EXPECT_LT(maximum,3)<<mode;
  }
  ImageTransform invalid;invalid.divisor[0]=0;EXPECT_THROW(cpu.RunNv12(input,invalid),std::invalid_argument);
}
TEST(ImagePreprocessor, DedicatedHardwareWithExplicitCpuReferenceColor){
  ImagePreprocessor processor({true,false,true});ImageTransform t;t.width=640;t.height=360;t.letterbox=false;
  Nv12Frame input{1920,1080,0,std::vector<uint8_t>(1920*1080*3/2,128)};
  EXPECT_EQ(processor.RunNv12(input,t).backend,"pym+cpu-color");
  t.erp_perspective=true;EXPECT_EQ(processor.RunNv12(input,t).backend,"gdc+cpu-color");
}
TEST(ImagePreprocessor, ExplicitReferenceAfterGpuInitializationFailure){
  struct RestoreEnvironment {
    std::string old;bool existed;
    RestoreEnvironment(){const char* value=std::getenv("AINVR_DRM_RENDER_NODE");existed=value!=nullptr;if(value)old=value;setenv("AINVR_DRM_RENDER_NODE","/dev/ainvr-deliberately-absent-test-device",1);}
    ~RestoreEnvironment(){if(existed)setenv("AINVR_DRM_RENDER_NODE",old.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");}
  } restore;
  ImagePreprocessor processor({false,true,true});ImageTransform t;t.width=96;t.height=96;
  Nv12Frame input{128,128,0,std::vector<uint8_t>(128*128*3/2,128)};
  for(int i=0;i<2;++i){auto result=processor.RunNv12(input,t);EXPECT_EQ(result.backend,"cpu");ASSERT_EQ(result.fallback_reasons.size(),1);EXPECT_NE(result.fallback_reasons[0].find("GLES unavailable"),std::string::npos);EXPECT_NEAR(result.chw[0],112.f/219,.001);}
}

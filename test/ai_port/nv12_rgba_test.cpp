// Copyright AINVR. CPU equations are test oracles; conversion executes on Mali.
#include "platform/gles_preprocess.hpp"
#include "gles_context.h"
#include <gtest/gtest.h>
#include <algorithm>
#include <cmath>
#include <future>
using namespace ainvr;
namespace {
std::vector<uint8_t> Image(int w,int h,int y,int u,int v){
  std::vector<uint8_t> pixels(size_t(w)*h*3/2,y);
  for(size_t i=size_t(w)*h;i<pixels.size();i+=2){pixels[i]=u;pixels[i+1]=v;}return pixels;
}
int Byte(double value){return std::clamp(int(std::floor(value+.5)),0,255);}
struct Caller {hw_gl context{};Caller(){if(hw_gl_open(&context))throw std::runtime_error("Test caller EGL unavailable");}~Caller(){hw_gl_close(&context);}};
}
TEST(Nv12Rgba,ColorAndRangeMatchIndependentReference){
  GlesPreprocessor gpu;
  for(bool full:{false,true})for(bool bt709:{false,true}){
    auto pixels=Image(32,16,80,100,170);ImageTransform t;t.width=32;t.height=16;t.letterbox=false;
    t.yuv_full_range=full;t.yuv_bt709=bt709;auto rgba=gpu.RunNv12Rgba(pixels,32,16,t);
    const double y=(80-(full?0:16))*(full?1:255.0/219),u=(100-128)*(full?1:255.0/224),v=(170-128)*(full?1:255.0/224);
    const int expected[4]={Byte(y+(bt709?1.5748:1.402)*v),Byte(y-(bt709?.187324:.344136)*u-(bt709?.468124:.714136)*v),Byte(y+(bt709?1.8556:1.772)*u),255};
    ASSERT_EQ(rgba.size(),size_t(32*16*4));
    for(size_t i=0;i<rgba.size();++i)ASSERT_NEAR(int(rgba[i]),expected[i%4],1);
  }
}
TEST(Nv12Rgba,OddSparse8KRegionRetainsSourceCoordinates){
  constexpr int w=7680,h=3840;auto pixels=Image(w,h,16,128,128);
  for(int y=0;y<h;++y)for(int x=0;x<w;++x)pixels[size_t(y)*w+x]=uint8_t(32+(x+y)%128);
  GlesPreprocessor gpu;ImageTransform t;t.width=67;t.height=45;t.letterbox=false;t.yuv_full_range=true;
  t.source_region=std::array<float,4>{3001,1503,67,45};t.nearest=true;
  auto rgba=gpu.RunNv12Rgba(pixels,w,h,t);ASSERT_EQ(rgba.size(),size_t(67*45*4));
  for(int y=0;y<45;++y)for(int x=0;x<67;++x){const int value=32+(3001+x+1503+y)%128;
    for(int c=0;c<3;++c)ASSERT_EQ(rgba[(size_t(y)*67+x)*4+c],value);
    ASSERT_EQ(rgba[(size_t(y)*67+x)*4+3],255);
  }
  RecordProperty("downloaded_rgba_bytes",int(rgba.size()));
}
TEST(Nv12Rgba,TwoBackendsAndDestructionRestoreCallerEgl){
  Caller caller;const auto display=eglGetCurrentDisplay(),context=eglGetCurrentContext();
  const auto draw=eglGetCurrentSurface(EGL_DRAW),read=eglGetCurrentSurface(EGL_READ);
  auto pixels=Image(32,16,80,128,128);ImageTransform t;t.width=32;t.height=16;t.letterbox=false;
  {
    GlesPreprocessor a,b;
    for(int cycle=0;cycle<3;++cycle){
      auto rgba=a.RunNv12Rgba(pixels,32,16,t);auto chw=b.RunNv12(pixels,32,16,t);
      ASSERT_EQ(rgba.size(),size_t(32*16*4));ASSERT_EQ(chw.size(),size_t(32*16*3));
      EXPECT_NEAR(rgba[0],chw[0]*255,1);
      EXPECT_EQ(eglGetCurrentContext(),context);EXPECT_EQ(eglGetCurrentDisplay(),display);
      EXPECT_EQ(eglGetCurrentSurface(EGL_DRAW),draw);EXPECT_EQ(eglGetCurrentSurface(EGL_READ),read);
    }
  }
  EXPECT_EQ(eglGetCurrentContext(),context);EXPECT_EQ(eglGetCurrentDisplay(),display);
}
TEST(Nv12Rgba,ValidationAndWrongThreadDoNotCorruptOwner){
  GlesPreprocessor gpu;auto pixels=Image(32,16,80,128,128);ImageTransform t;t.width=31;t.height=17;t.letterbox=false;
  EXPECT_THROW(gpu.RunNv12Rgba({},32,16,t),std::invalid_argument);
  auto rejected=std::async(std::launch::async,[&]{try{gpu.RunNv12Rgba(pixels,32,16,t);return false;}catch(const std::runtime_error&){return true;}});
  EXPECT_TRUE(rejected.get());auto rgba=gpu.RunNv12Rgba(pixels,32,16,t);EXPECT_EQ(rgba.size(),size_t(31*17*4));
}

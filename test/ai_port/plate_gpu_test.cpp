// Explicit hardware tests, synthetic pixel oracle only.
#include "adapters/plate_decode.hpp"
#include "platform/gles_preprocess.hpp"
#include <gtest/gtest.h>
TEST(PlateGpu,ProjectiveIdentityPreservesPixels){
 ainvr::GlesPreprocessor gpu;std::vector<uint8_t> pixels(64*48*4);
 for(int y=0;y<48;++y)for(int x=0;x<64;++x){size_t i=(y*64+x)*4;pixels[i]=x*3;pixels[i+1]=y*4;pixels[i+2]=60;pixels[i+3]=255;}
 ainvr::ImageTransform t;t.width=64;t.height=48;t.letterbox=false;
 auto original=gpu.RunRgbaRgba(pixels,64,48,t);t.projective_uv=std::array<float,9>{1,0,0,0,1,0,0,0,1};
 EXPECT_EQ(gpu.RunRgbaRgba(pixels,64,48,t),original);
}
TEST(PlateGpu,ProjectiveCropMatchesPixelRegion){
 ainvr::GlesPreprocessor gpu;std::vector<uint8_t> pixels(64*48*4);
 for(int y=0;y<48;++y)for(int x=0;x<64;++x){size_t i=(y*64+x)*4;pixels[i]=x*3;pixels[i+1]=y*4;pixels[i+2]=60;pixels[i+3]=255;}
 ainvr::ImageTransform t;t.width=32;t.height=24;t.letterbox=false;t.source_region=std::array<float,4>{16,12,32,24};
 auto crop=gpu.RunRgbaRgba(pixels,64,48,t);t.source_region.reset();t.projective_uv=ainvr::plate::Homography({{{16,12},{48,12},{48,36},{16,36}}},64,48);
 EXPECT_EQ(gpu.RunRgbaRgba(pixels,64,48,t),crop);
}
TEST(PlateGpu,DoubleRowsKeepOrder){
 ainvr::GlesPreprocessor gpu;std::vector<uint8_t> pixels(32*48*4,255);
 for(int y=0;y<48;++y)for(int x=0;x<32;++x){size_t i=(y*32+x)*4;pixels[i]=y<16?200:20;pixels[i+1]=y<16?20:200;pixels[i+2]=0;}
 ainvr::ImageTransform t;t.width=64;t.height=32;t.letterbox=false;t.plate_split_height=48;
 auto rows=gpu.RunRgbaRgba(pixels,32,48,t);size_t left=(4*64+16)*4,right=(4*64+48)*4;
 EXPECT_EQ(rows[left],200);EXPECT_EQ(rows[left+1],20);EXPECT_EQ(rows[right],20);EXPECT_EQ(rows[right+1],200);
}

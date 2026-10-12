#include <gtest/gtest.h>
#include <future>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include "output/exposure.hpp"
#include "output/snapshot_jpeg.hpp"
#include "platform/gles_preprocess.hpp"
using namespace ai_service::output;
TEST(SnapshotJpu, TinyRgbaCanvasKeepsPixelsAndEncodesWithoutCpuFallback) {
 for(auto size:{cv::Size(1,1),cv::Size(16,64),cv::Size(64,16),cv::Size(13,29)}){
  cv::Mat input(size,CV_8UC4);
  for(int y=0;y<input.rows;++y)for(int x=0;x<input.cols;++x)
   input.at<cv::Vec4b>(y,x)={uint8_t(x*3),uint8_t(y*2),uint8_t((x+y)*2),255};
  auto before=GetSnapshotJpegStats();auto actual=EnsureSnapshotJpuCanvas(input);
  ASSERT_EQ(actual.cols,std::max(17,input.cols));ASSERT_EQ(actual.rows,std::max(17,input.rows));
  for(int y=0;y<actual.rows;++y)for(int x=0;x<actual.cols;++x)
   ASSERT_EQ(actual.at<cv::Vec4b>(y,x),input.at<cv::Vec4b>(std::min(y,input.rows-1),std::min(x,input.cols-1)));
  std::vector<uint8_t> jpeg;ASSERT_TRUE(EncodeSnapshotRgbaJpeg(actual,jpeg,95));
  auto decoded=cv::imdecode(jpeg,cv::IMREAD_COLOR);ASSERT_EQ(decoded.size(),actual.size());
  auto after=GetSnapshotJpegStats();EXPECT_EQ(after.jpu,before.jpu+1);EXPECT_EQ(after.cpu,0);
  EXPECT_EQ(after.failures,before.failures);
 }
 cv::Mat ordinary(35,33,CV_8UC4);EXPECT_EQ(EnsureSnapshotJpuCanvas(ordinary).data,ordinary.data);
}
TEST(SnapshotJpu, NativeRgbaColorPaddingMatchesBgrAndExplicitPixelOracle) {
 const int w=33,h=35,ow=48,oh=40;
 std::vector<uint8_t> rgba(w*h*4),bgr(w*h*3);
 for(int y=0;y<h;++y)for(int x=0;x<w;++x){const int i=y*w+x;
  rgba[4*i]=(x*3+y*7)%256;rgba[4*i+1]=(x*2+y*5)%256;
  rgba[4*i+2]=(x*7+y*3)%256;rgba[4*i+3]=(x+y)%256;
  for(int c=0;c<3;++c)bgr[3*i+c]=rgba[4*i+2-c];
 }
 ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;t.width=ow;t.height=oh;
 t.letterbox=false;t.nearest=true;t.source_region=std::array<float,4>{0,0,float(ow),float(oh)};
 // JPEG entry point must override model normalization and channel settings.
 t.mean={90,23,17};t.divisor={17,19,23};t.bgr=true;
 auto actual=gpu.RunRgbaJpegNv12(rgba,w,h,t);
 EXPECT_EQ(actual,gpu.RunBgrJpegNv12(bgr,w,h,t));
 ASSERT_EQ(actual.size(),ow*oh*3/2);
 auto pixel=[&](int x,int y,int c){return double(rgba[(std::min(y,h-1)*w+std::min(x,w-1))*4+c]);};
 auto byte=[](double value){return std::clamp(std::floor(value+.5),0.,255.);};
 for(int y=0;y<oh;y+=2)for(int x=0;x<ow;x+=2){double r=0,g=0,b=0;
  for(int dy=0;dy<2;++dy)for(int dx=0;dx<2;++dx){double rr=pixel(x+dx,y+dy,0),gg=pixel(x+dx,y+dy,1),bb=pixel(x+dx,y+dy,2);
   EXPECT_NEAR(actual[(y+dy)*ow+x+dx],byte(.299*rr+.587*gg+.114*bb),1);r+=rr;g+=gg;b+=bb;}
  const int i=ow*oh+(y/2)*ow+x;
  EXPECT_NEAR(actual[i],byte(128+(-.168736*r-.331264*g+.5*b)/4),1);
  EXPECT_NEAR(actual[i+1],byte(128+(.5*r-.418688*g-.081312*b)/4),1);
 }
 for(size_t i=3;i<rgba.size();i+=4)rgba[i]=255-rgba[i];
 EXPECT_EQ(actual,gpu.RunRgbaJpegNv12(rgba,w,h,t));
 EXPECT_THROW(gpu.RunRgbaJpegNv12(bgr,w,h,t),std::invalid_argument);
 t.width=47;EXPECT_THROW(gpu.RunRgbaJpegNv12(rgba,w,h,t),std::invalid_argument);
}
TEST(SnapshotJpu, RgbaOddNoncontiguousCropsMatchExistingJpuBytesAndColors) {
 for(auto size:{cv::Size(17,17),cv::Size(65,63),cv::Size(31,33),cv::Size(8191,17)}){
  cv::Mat backing(size.height+4,size.width+6,CV_8UC4,cv::Scalar(170,90,20,13));
  auto input=backing(cv::Rect(2,2,size.width,size.height));ASSERT_FALSE(input.isContinuous());
  cv::Mat bgr;cv::cvtColor(input,bgr,cv::COLOR_RGBA2BGR); // Explicit test oracle only.
  auto before=GetSnapshotJpegStats();std::vector<uint8_t> rgba_jpeg,bgr_jpeg;
  ASSERT_TRUE(EncodeSnapshotRgbaJpeg(input,rgba_jpeg,95));
  ASSERT_TRUE(EncodeSnapshotJpeg(bgr,bgr_jpeg,95));
  EXPECT_EQ(rgba_jpeg,bgr_jpeg);
  auto decoded=cv::imdecode(rgba_jpeg,cv::IMREAD_COLOR);ASSERT_EQ(decoded.size(),size);
  auto mean=cv::mean(decoded);EXPECT_NEAR(mean[0],20,5);EXPECT_NEAR(mean[1],90,5);EXPECT_NEAR(mean[2],170,5);
  auto after=GetSnapshotJpegStats();EXPECT_EQ(after.jpu,before.jpu+2);
  EXPECT_EQ(after.gpu_color,before.gpu_color+2);EXPECT_EQ(after.cpu,0);
 }
}
TEST(SnapshotJpu, OriginalAndCorrectedRgbaVariantsUseOnlyGpuAndJpu) {
 cv::Mat input(63,65,CV_8UC4,cv::Scalar(40,40,40,91));
 std::vector<uint8_t> original,corrected;auto before=GetSnapshotJpegStats();
 ASSERT_TRUE(EncodeSnapshotRgbaJpeg(input,original,95));
 auto lifted=CorrectExposureRgba(input,220);
 ASSERT_TRUE(EncodeSnapshotRgbaJpeg(lifted,corrected,95));
 auto raw=cv::imdecode(original,cv::IMREAD_COLOR),processed=cv::imdecode(corrected,cv::IMREAD_COLOR);
 ASSERT_EQ(raw.size(),input.size());ASSERT_EQ(processed.size(),input.size());
 EXPECT_NEAR(cv::mean(raw)[0],40,5);EXPECT_GE(cv::mean(processed)[0],58);
 auto after=GetSnapshotJpegStats();EXPECT_EQ(after.jpu,before.jpu+2);
 EXPECT_EQ(after.gpu_color,before.gpu_color+2);EXPECT_EQ(after.cpu,0);
}
TEST(SnapshotJpu, MixedRgbaAndBgrArchiveWorkersShareOneManagedHardwareQueue) {
 auto before=GetSnapshotJpegStats();std::vector<std::future<bool>> work;
 for(int worker=0;worker<4;++worker)work.push_back(std::async(std::launch::async,[worker]{
  for(int i=0;i<5;++i){bool rgba=(worker+i)%2==0;
   cv::Mat input(33+worker,65+i,rgba?CV_8UC4:CV_8UC3,
     rgba?cv::Scalar(170,90,20,7):cv::Scalar(20,90,170));std::vector<uint8_t> jpeg;
   bool ok=rgba?EncodeSnapshotRgbaJpeg(input,jpeg,80+i):EncodeSnapshotJpeg(input,jpeg,80+i);
   auto decoded=cv::imdecode(jpeg,cv::IMREAD_COLOR);
   if(!ok||decoded.size()!=input.size()||std::abs(cv::mean(decoded)[2]-170)>8)return false;
  }return true;
 }));
 for(auto& future:work)EXPECT_TRUE(future.get());auto after=GetSnapshotJpegStats();
 EXPECT_EQ(after.jpu,before.jpu+20);EXPECT_EQ(after.gpu_color,before.gpu_color+20);
 EXPECT_EQ(after.failures,before.failures);EXPECT_EQ(after.cpu,0);
}
TEST(SnapshotJpu, RgbaWarmEndToEndEncodingPerformance) {
 cv::Mat input(319,321,CV_8UC4,cv::Scalar(170,90,20,7));std::vector<uint8_t> jpeg;
 for(int i=0;i<3;++i)ASSERT_TRUE(EncodeSnapshotRgbaJpeg(input,jpeg,90));
 auto start=std::chrono::steady_clock::now();auto before=GetSnapshotJpegStats();
 for(int i=0;i<12;++i)ASSERT_TRUE(EncodeSnapshotRgbaJpeg(input,jpeg,90));
 double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()/12;
 RecordProperty("rgba_complete_encode_ms_321x319",std::to_string(ms));
 EXPECT_EQ(GetSnapshotJpegStats().jpu,before.jpu+12);
 EXPECT_EQ(cv::imdecode(jpeg,cv::IMREAD_COLOR).size(),input.size());
}
TEST(SnapshotJpu, NativeRgbaInvalidInputsAreRejectedAndClearStaleBytes) {
 cv::Mat valid(64,64,CV_8UC4,cv::Scalar(1,2,3,4));std::vector<uint8_t> out{1,2,3};
 EXPECT_THROW(EncodeSnapshotRgbaJpeg(cv::Mat(64,64,CV_8UC3),out,90),std::invalid_argument);
 EXPECT_TRUE(out.empty());
 EXPECT_THROW(EncodeSnapshotRgbaJpeg({},out,90),std::invalid_argument);
 for(int quality:{0,101})EXPECT_THROW(EncodeSnapshotRgbaJpeg(valid,out,quality),std::invalid_argument);
 for(auto size:{cv::Size(1,1),cv::Size(16,64),cv::Size(64,16),cv::Size(8193,18)})
  EXPECT_THROW(EncodeSnapshotRgbaJpeg(cv::Mat(size,CV_8UC4),out,90),std::invalid_argument);
 EXPECT_EQ(GetSnapshotJpegStats().cpu,0);
}
TEST(SnapshotJpu, GpuColorAndEdgePaddingMatchExplicitCpuTestOracle) {
 const int w=33,h=35,ow=48,oh=40;std::vector<uint8_t> bgr(w*h*3);
 for(int y=0;y<h;++y)for(int x=0;x<w;++x){auto i=(y*w+x)*3;
  bgr[i]=(x*7+y*3)%256;bgr[i+1]=(x*2+y*5)%256;bgr[i+2]=(x*3+y*7)%256;}
 ainvr::GlesPreprocessor gpu;ainvr::ImageTransform t;t.width=ow;t.height=oh;
 t.letterbox=false;t.nearest=true;t.source_region=std::array<float,4>{0,0,float(ow),float(oh)};
 auto actual=gpu.RunBgrJpegNv12(bgr,w,h,t);ASSERT_EQ(actual.size(),ow*oh*3/2);
 auto pixel=[&](int x,int y,int c){return double(bgr[(std::min(y,h-1)*w+std::min(x,w-1))*3+c]);};
 auto byte=[](double value){return std::clamp(std::floor(value+.5),0.,255.);};
 for(int y=0;y<oh;y+=2)for(int x=0;x<ow;x+=2){double r=0,g=0,b=0;
  for(int dy=0;dy<2;++dy)for(int dx=0;dx<2;++dx){double rr=pixel(x+dx,y+dy,2),gg=pixel(x+dx,y+dy,1),bb=pixel(x+dx,y+dy,0);
   EXPECT_NEAR(actual[(y+dy)*ow+x+dx],byte(.299*rr+.587*gg+.114*bb),1);r+=rr;g+=gg;b+=bb;}
  int i=ow*oh+(y/2)*ow+x;
  EXPECT_NEAR(actual[i],byte(128+(-.168736*r-.331264*g+.5*b)/4),1);
  EXPECT_NEAR(actual[i+1],byte(128+(.5*r-.418688*g-.081312*b)/4),1);
 }
}
TEST(SnapshotJpu, RealHardwarePreservesColorSizeAndNoncontiguousInput) {
 for(const auto color : {cv::Scalar(0,0,255),cv::Scalar(255,0,0),cv::Scalar(0,255,0),cv::Scalar(0,0,0),cv::Scalar(255,255,255),cv::Scalar(128,128,128)}) {
  cv::Mat backing(70,100,CV_8UC3,color);auto input=backing(cv::Rect(2,2,64,64));
  ASSERT_FALSE(input.isContinuous());auto before=GetSnapshotJpegStats();std::vector<uint8_t> jpeg;
  ASSERT_TRUE(EncodeSnapshotJpeg(input,jpeg,95));auto after=GetSnapshotJpegStats();
  ASSERT_EQ(after.jpu,before.jpu+1);ASSERT_EQ(after.cpu,before.cpu);
  ASSERT_EQ(after.gpu_color,before.gpu_color+1);
  auto decoded=cv::imdecode(jpeg,cv::IMREAD_COLOR);ASSERT_EQ(decoded.size(),input.size());
  auto mean=cv::mean(decoded);for(int c=0;c<3;++c)EXPECT_NEAR(mean[c],color[c],5);
 }
}
TEST(SnapshotJpu, OddCropsKeepExactDimensionsUsingGpuAndJpu) {
 for(auto size : {cv::Size(17,17),cv::Size(65,63),cv::Size(31,33),cv::Size(8191,17)}) {
  cv::Mat input(size,CV_8UC3,cv::Scalar(20,90,170));std::vector<uint8_t> jpeg;auto before=GetSnapshotJpegStats();
  ASSERT_TRUE(EncodeSnapshotJpeg(input,jpeg,90));auto after=GetSnapshotJpegStats();
  EXPECT_EQ(after.cpu,before.cpu);EXPECT_EQ(after.jpu,before.jpu+1);
  EXPECT_EQ(after.gpu_color,before.gpu_color+1);
  EXPECT_EQ(cv::imdecode(jpeg,cv::IMREAD_COLOR).size(),size);
 }
}
TEST(SnapshotJpu, ParallelArchiveWorkersCanChangeDimensionsAndQuality) {
 auto before=GetSnapshotJpegStats();std::vector<std::future<bool>> work;
 for(int worker=0;worker<4;++worker)work.push_back(std::async(std::launch::async,[worker] {
  for(int i=0;i<5;++i) {
   cv::Mat input(48+2*worker,64+2*i,CV_8UC3,cv::Scalar(20,100,180));std::vector<uint8_t> jpeg;
   if(!EncodeSnapshotJpeg(input,jpeg,80+i))return false;
   if(cv::imdecode(jpeg,cv::IMREAD_COLOR).size()!=input.size())return false;
  }return true;
 }));
 for(auto& f:work)EXPECT_TRUE(f.get());auto after=GetSnapshotJpegStats();
 EXPECT_EQ(after.jpu,before.jpu+20);EXPECT_EQ(after.failures,before.failures);
 EXPECT_EQ(after.gpu_color,before.gpu_color+20);EXPECT_EQ(after.cpu,0);
}
TEST(SnapshotJpu, InvalidInputsAreRejected) {
 std::vector<uint8_t> out;cv::Mat image(64,64,CV_8UC3);
 EXPECT_THROW(EncodeSnapshotJpeg({},out,90),std::invalid_argument);
 EXPECT_THROW(EncodeSnapshotJpeg(image,out,0),std::invalid_argument);
 EXPECT_THROW(EncodeSnapshotJpeg(image,out,101),std::invalid_argument);
 for(auto size:{cv::Size(1,1),cv::Size(16,64),cv::Size(64,16),cv::Size(8193,18)}){
  cv::Mat invalid(size,CV_8UC3);EXPECT_THROW(EncodeSnapshotJpeg(invalid,out,90),std::invalid_argument);
 }
 EXPECT_EQ(GetSnapshotJpegStats().cpu,0);
}

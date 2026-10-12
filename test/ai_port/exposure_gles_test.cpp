// Copyright AINVR. CPU oracle is linked only in this hardware acceptance test.
#include <gtest/gtest.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <chrono>
#include <future>
#include <cstdlib>
#include <opencv2/imgcodecs.hpp>
#include "output/exposure.hpp"
#include "output/exposure_backend.hpp"
#include "output/snapshot_jpeg.hpp"
#include "platform/gles_preprocess.hpp"
namespace ai_service::output {
cv::Mat CorrectExposureReference(const cv::Mat&,double,double,double,double,double,double,bool);
cv::Mat CorrectExposureRgbaReference(const cv::Mat&,double,double);
}
using namespace ai_service::output;
TEST(ExposureGles, OriginalAlgorithmMatchesAcrossBordersSizesAndTargets) {
  cv::RNG rng(123);
  double maximum=0,total_ms=0;int cases=0;
  for(auto size:{cv::Size(1,1),cv::Size(1,23),cv::Size(33,17),cv::Size(128,128),cv::Size(320,320),cv::Size(513,259)}){
    cv::Mat backing(size.height+4,size.width+4,CV_8UC3);
    rng.fill(backing,cv::RNG::UNIFORM,0,256);
    auto input=backing(cv::Rect(1,1,size.width,size.height));
    for(double target:{0.,128.,220.,255.}){
      auto reference=CorrectExposureReference(input,target,.6,3.,.1,.8,.2,false);
      auto start=std::chrono::steady_clock::now();
      auto actual=CorrectExposure(input,target);
      total_ms+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
      double error=cv::norm(reference,actual,cv::NORM_INF);maximum=std::max(maximum,error);++cases;
      EXPECT_LE(error,2.)<<size<<" target="<<target;
    }
  }
  RecordProperty("cases",cases);RecordProperty("maximum_code_value_error",maximum);
  RecordProperty("mean_complete_call_ms",std::to_string(total_ms/cases));
  EXPECT_GE(GetExposureBackendStats().gpu_runs,uint64_t(cases));
  EXPECT_EQ(GetExposureBackendStats().cpu_runs,0u);
}
TEST(ExposureGles, OriginalParametersAndAlphaArePreserved) {
  cv::Mat input(65,79,CV_8UC4);cv::RNG rng(987);rng.fill(input,cv::RNG::UNIFORM,0,256);
  auto actual=CorrectExposureRgba(input,220,.75);
  auto reference=CorrectExposureRgbaReference(input,220,.75);
  EXPECT_LE(cv::norm(actual,reference,cv::NORM_INF),2.);
  for(int y=0;y<input.rows;++y)for(int x=0;x<input.cols;++x)
    EXPECT_EQ(actual.at<cv::Vec4b>(y,x)[3],input.at<cv::Vec4b>(y,x)[3]);
  cv::Mat bgr;cv::cvtColor(input,bgr,cv::COLOR_RGBA2BGR);
  for(auto parameters:{std::array<double,4>{1.5,.03,.2,0.},std::array<double,4>{4.,.5,2.,.4}}){
    auto ref=CorrectExposureReference(bgr,128,.6,parameters[0],parameters[1],parameters[2],parameters[3],false);
    auto got=CorrectExposure(bgr,128,.6,parameters[0],parameters[1],parameters[2],parameters[3]);
    EXPECT_LE(cv::norm(ref,got,cv::NORM_INF),2.);
  }
  EXPECT_EQ(cv::norm(CorrectExposureRgba(input,128,0),input,cv::NORM_INF),0);
}
TEST(ExposureGles, TonalTextureEndpointsAndDarkLiftKeepOriginalBehavior) {
  cv::Mat gradient(32,256,CV_8UC3);
  for(int y=0;y<gradient.rows;++y)for(int v=0;v<256;++v)gradient.at<cv::Vec3b>(y,v)=cv::Vec3b::all(v);
  for(double target:{0.,80.,128.,180.,255.}){
    auto result=CorrectExposure(gradient,target);
    auto ref=CorrectExposureReference(gradient,target,.6,3.,.1,.8,.2,false);
    EXPECT_LE(cv::norm(result,ref,cv::NORM_INF),2.);
    EXPECT_EQ(result.at<cv::Vec3b>(16,0)[0],0);
    for(int v=1;v<255;++v){EXPECT_GE(result.at<cv::Vec3b>(16,v)[0],1);EXPECT_LE(result.at<cv::Vec3b>(16,v)[0],254);}
  }
  cv::Mat dark(64,64,CV_8UC3,cv::Scalar::all(40));auto lifted=CorrectExposure(dark,220);
  EXPECT_GE(cv::mean(lifted)[0],58);EXPECT_LE(cv::mean(lifted)[0],80);
  cv::Mat black(64,64,CV_8UC3,cv::Scalar::all(0));
  EXPECT_EQ(cv::countNonZero(CorrectExposure(black,220).reshape(1)),0);
}
TEST(ExposureGles, CallerContextAndConcurrentArchiveWorkersRemainUsable) {
  ainvr::GlesPreprocessor images;
  ainvr::ImageTransform t;t.width=32;t.height=32;t.letterbox=false;
  std::vector<uint8_t> pixels(32*32*4,80);
  auto before=images.Run(pixels,32,32,t);
  cv::Mat input(32,32,CV_8UC3,cv::Scalar::all(40));CorrectExposure(input,220);
  EXPECT_EQ(before,images.Run(pixels,32,32,t));
  std::vector<std::future<cv::Mat>> workers;
  for(int i=0;i<4;++i)workers.push_back(std::async(std::launch::async,[input]{return CorrectExposure(input,220);}));
  auto reference=CorrectExposureReference(input,220,.6,3.,.1,.8,.2,false);
  for(auto& worker:workers)EXPECT_LE(cv::norm(worker.get(),reference,cv::NORM_INF),2.);
}
TEST(ExposureGles, InvalidParametersAndCpuFallbackAreRejected) {
  cv::Mat input(32,32,CV_8UC3,cv::Scalar::all(40));
  EXPECT_THROW(CorrectExposure(input,128,.6,3.,.1,.8,.2,false),std::invalid_argument);
  EXPECT_THROW(CorrectExposure(input,256),std::invalid_argument);
  EXPECT_THROW(CorrectExposureRgba(input),std::invalid_argument);
  EXPECT_THROW(CorrectExposure(cv::Mat()),std::invalid_argument);
}
TEST(ExposureGles, HardwareFailureIsVisibleAndSameWorkerCanRetry) {
  auto job=std::async(std::launch::async,[]{
    const char* existing=std::getenv("AINVR_DRM_RENDER_NODE");
    const std::string previous=existing?existing:"";
    auto before=GetExposureBackendStats();
    setenv("AINVR_DRM_RENDER_NODE","/nonexistent/ainvr-exposure-test",1);
    cv::Mat input(32,32,CV_8UC3,cv::Scalar::all(40));
    EXPECT_THROW(CorrectExposure(input,220),std::runtime_error);
    if(existing)setenv("AINVR_DRM_RENDER_NODE",previous.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");
    EXPECT_EQ(GetExposureBackendStats().failures,before.failures+1);
    auto actual=CorrectExposure(input,220);
    auto reference=CorrectExposureReference(input,220,.6,3.,.1,.8,.2,false);
    EXPECT_LE(cv::norm(actual,reference,cv::NORM_INF),2.);
    EXPECT_EQ(GetExposureBackendStats().cpu_runs,0u);
  });
  job.get();
}
TEST(ExposureGles, WarmCropPerformanceAndGpuJpuArchiveChain) {
  cv::Mat input(319,321,CV_8UC3);cv::RNG rng(321);rng.fill(input,cv::RNG::UNIFORM,0,256);
  for(int i=0;i<3;++i)CorrectExposure(input,180);
  auto before=GetExposureBackendStats();
  const auto start=std::chrono::steady_clock::now();
  cv::Mat actual;
  for(int i=0;i<12;++i)actual=CorrectExposure(input,180);
  const double mean=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()/12;
  RecordProperty("warm_complete_call_ms_321x319",std::to_string(mean));
  EXPECT_EQ(GetExposureBackendStats().gpu_runs,before.gpu_runs+12);
  auto reference=CorrectExposureReference(input,180,.6,3.,.1,.8,.2,false);
  EXPECT_LE(cv::norm(actual,reference,cv::NORM_INF),2.);
  cv::Mat dark(63,65,CV_8UC4,cv::Scalar(40,40,40,91));
  auto rgba=CorrectExposureRgba(dark,220);
  auto jpeg_before=GetSnapshotJpegStats();std::vector<uint8_t> encoded;
  ASSERT_TRUE(EncodeSnapshotRgbaJpeg(rgba,encoded,95));
  auto jpeg_after=GetSnapshotJpegStats();
  EXPECT_EQ(jpeg_after.jpu,jpeg_before.jpu+1);EXPECT_EQ(jpeg_after.cpu,0);
  auto decoded=cv::imdecode(encoded,cv::IMREAD_COLOR);
  ASSERT_EQ(decoded.size(),dark.size());EXPECT_GE(cv::mean(decoded)[0],58);
}

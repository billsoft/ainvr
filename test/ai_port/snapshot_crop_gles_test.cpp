// Copyright AINVR. CPU images/maps below are explicit test oracles only.
#include <gtest/gtest.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <future>
#include <thread>
#include <limits>
#include <opencv2/imgproc.hpp>
#include <opencv2/imgcodecs.hpp>
#include "output/snapshot_store.hpp"
#include "output/exposure.hpp"
#include "output/exposure_backend.hpp"
#include "output/snapshot_jpeg.hpp"
#include "platform/gles_crop.hpp"
#include "platform/gles_preprocess.hpp"
namespace ai_service::output {
cv::Mat CropWithPaddingReference(const cv::Mat&,const std::array<double,4>&,double,int,bool);
std::pair<cv::Mat,cv::Mat> BuildErpMapReference(int,int,double,double,double,int,int);
cv::Mat SampleErpPerspectiveReference(const cv::Mat&,const cv::Mat&,const cv::Mat&);
}
using namespace ai_service::output;
using namespace ai_service;
namespace {
cv::Mat Pattern(cv::Size size,bool noise=false){
  cv::Mat image(size,CV_8UC4);
  if(noise){cv::RNG rng(42);rng.fill(image,cv::RNG::UNIFORM,0,256);return image;}
  for(int y=0;y<size.height;++y)for(int x=0;x<size.width;++x)
    image.at<cv::Vec4b>(y,x)={uint8_t(x*220/size.width),uint8_t(y*220/size.height),
      uint8_t(80+30*std::sin(x*.009)+30*std::cos(y*.007)),uint8_t(30+x*190/size.width)};
  return image;
}
cv::Mat Reference(const cv::Mat& image,const ErpView& view){
  auto ss=ScaleErpView(view,1.5);
  auto [x,y]=BuildErpMapReference(image.cols,image.rows,ss.cx,ss.cy,ss.fov_h_deg,ss.w_out,ss.h_out);
  cv::Mat result;auto sample=SampleErpPerspectiveReference(image,x,y);
  cv::resize(sample,result,{view.w_out,view.h_out},0,0,cv::INTER_CUBIC);return result;
}
double MeanError(const cv::Mat& a,const cv::Mat& b){return cv::norm(a,b,cv::NORM_L1)/(a.total()*a.channels());}
Detection Detect(std::array<double,4> bbox){Detection d;d.bbox=bbox;return d;}
}
TEST(SnapshotCropGles, AreaCropPreservesOriginalPaddingDimensionsAndPixels){
  for(bool noise:{false,true})for(auto size:{cv::Size(1,1),cv::Size(33,17),cv::Size(513,259)}){
    auto image=Pattern(size,noise);
    const std::vector<std::array<double,4>> boxes{
      {0,0,double(size.width),double(size.height)},
      {-2.5,-3.5,17.5,13.5},{3.5,4.5,23.,9.},{-10,-10,2,2},
      {double(size.width-2),double(size.height-2),14.5,11.5}};
    for(bool square:{false,true})for(auto box:boxes)for(int maximum:{16,32,320}){
      auto reference=CropWithPaddingReference(image,box,.25,maximum,square);
      auto actual=CropWithPadding(image,box,.25,maximum,square);
      ASSERT_EQ(actual.size(),reference.size());if(actual.empty())continue;
      EXPECT_LE(cv::norm(actual,reference,cv::NORM_INF),1.);
      EXPECT_LE(MeanError(actual,reference),.3);
    }
  }
}
TEST(SnapshotCropGles, HugeSquareKeepsBoundedLinearException){
  cv::Mat image=Pattern({128,96},true);std::array<double,4> box{-5000,-5000,10000,10000};
  auto actual=CropWithPadding(image,box,.25,320,true);
  auto reference=CropWithPaddingReference(image,box,.25,320,true);
  ASSERT_EQ(actual.size(),cv::Size(320,320));EXPECT_LE(cv::norm(actual,reference,cv::NORM_INF),1.);
}
TEST(SnapshotCropGles, OrdinaryRoiUnionKeepsGlobalRoundingAndReplicatedBorders){
  auto image=Pattern({513,259},true);
  const std::vector<std::array<double,4>> boxes{
    {101.5,77.5,23,9},{-2.5,-3.5,17.5,13.5},
    {508.5,253.5,14.5,11.5},{100,79,13,13},{700,400,10,10}};
  for(bool square:{false,true})for(double padding:{0.,.25}){
    SnapshotCropper cropper;cv::Rect downloaded;int calls=0;
    pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){
      downloaded=roi;++calls;dst=image(roi);
    }};
    config::SnapshotConfig cfg;cfg.projection_mode="none";cfg.padding_ratio=padding;cfg.max_crop_dimension=32;
    std::vector<Detection> detections;for(auto b:boxes)detections.push_back(Detect(b));
    auto actual=cropper.Crop(provider,detections,square,cfg);
    ASSERT_EQ(actual.size(),boxes.size());EXPECT_EQ(calls,1);
    EXPECT_EQ(cropper.invalid_count(),1u);
    for(size_t n=0;n<boxes.size();++n){
      auto expected=CropWithPaddingReference(image,boxes[n],padding,32,square);
      ASSERT_EQ(actual[n].size(),expected.size());if(expected.empty())continue;
      EXPECT_LE(cv::norm(actual[n],expected,cv::NORM_INF),1.);
    }
  }
  // A single interior target must transfer only its rounded source rectangle.
  SnapshotCropper cropper;int calls=0;cv::Rect downloaded;
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){
    downloaded=roi;++calls;dst=image(roi);
  }};
  config::SnapshotConfig cfg;cfg.padding_ratio=0;cfg.max_crop_dimension=32;
  auto got=cropper.Crop(provider,{Detect({101.5,77.5,23,9})},true,cfg);
  EXPECT_EQ(downloaded,cv::Rect(102,70,23,23));
  EXPECT_EQ(calls,1);EXPECT_FALSE(cropper.full_frame());
  EXPECT_EQ(cropper.downloaded_bytes(),size_t(23*23*4));
  auto expected=CropWithPaddingReference(image,{101.5,77.5,23,9},0,32,true);
  EXPECT_LE(cv::norm(got[0],expected,cv::NORM_INF),1.);
}
TEST(SnapshotCropGles, EightKWidthIsPreservedBeyondThePymFourKLimit){
  auto image=Pattern({8191,17},true);auto before=ainvr::GetGlesCropStats();
  auto actual=CropWithPadding(image,{0,0,8191,17},0,8192,false);
  ASSERT_EQ(actual.size(),image.size());EXPECT_EQ(cv::norm(actual,image,cv::NORM_INF),0);
  EXPECT_EQ(ainvr::GetGlesCropStats().crops,before.crops+1);
  // Same hardware path also downsamples the wide source with area weighting.
  auto small=CropWithPadding(image,{0,0,8191,17},0,4096,false);
  auto reference=CropWithPaddingReference(image,{0,0,8191,17},0,4096,false);
  ASSERT_EQ(small.size(),reference.size());EXPECT_LE(cv::norm(small,reference,cv::NORM_INF),1.);
}
TEST(SnapshotCropGles, ErpCubicSupersamplingPreservesOriginalGeometryAndQuality){
  double maximum=0,mean=0;int cases=0;
  for(auto size:{cv::Size(3840,1920),cv::Size(7680,3840)}){
    // Geometry oracle builds each view afresh. One entry forces cold maps in
    // this sequence, including exact/near poles sharing a 3-degree key.
    // First-view quantized reuse is tested independently below.
    auto image=Pattern(size);ainvr::GlesCropBackend gpu(1);gpu.Upload(image);
    for(auto center:{cv::Point2d(.5,.5),cv::Point2d(.005,.5),cv::Point2d(.995,.5),
                     cv::Point2d(.5,.005),cv::Point2d(.5,.995),cv::Point2d(0,.5),
                     cv::Point2d(1,.5),cv::Point2d(.5,0),cv::Point2d(.5,1)}){
      ErpView view{center.x*size.width,center.y*size.height,110,321,239};
      auto map=gpu.GetMap(size,ScaleErpView(view,1.5));ASSERT_TRUE(map->finite);
      auto actual=gpu.Remap(map,{}, {view.w_out,view.h_out});auto reference=Reference(image,view);
      const double error=cv::norm(actual,reference,cv::NORM_INF),average=MeanError(actual,reference);
      maximum=std::max(maximum,error);mean+=average;++cases;
      EXPECT_LE(error,4.);EXPECT_LE(average,.2);
      // ROI and full frame must sample the exact same GPU-generated map.
      gpu.Upload(image(map->required));
      EXPECT_EQ(cv::norm(actual,gpu.Remap(map,map->required.tl(),actual.size()),cv::NORM_INF),0);
      gpu.Upload(image);
    }
  }
  RecordProperty("erp_smooth_cases",cases);RecordProperty("erp_smooth_max_error",std::to_string(maximum));
  RecordProperty("erp_smooth_mean_error",std::to_string(mean/cases));
}
TEST(SnapshotCropGles, HighFrequencyPixelsRetainCubicQuality){
  auto image=Pattern({1024,512},true);ainvr::GlesCropBackend gpu;gpu.Upload(image);
  ErpView view{512,256,93,320,241};auto map=gpu.GetMap(image.size(),ScaleErpView(view,1.5));
  auto actual=gpu.Remap(map,{}, {view.w_out,view.h_out}),reference=Reference(image,view);
  double error=cv::norm(actual,reference,cv::NORM_INF),mean=MeanError(actual,reference);
  RecordProperty("erp_noise_max_error",std::to_string(error));RecordProperty("erp_noise_mean_error",std::to_string(mean));
  EXPECT_LE(error,12.);EXPECT_LE(mean,.6);
}
TEST(SnapshotCropGles, QuantizedCacheKeepsFirstViewAndRetainedMapsSurviveEviction){
  auto image=Pattern({1024,512});ainvr::GlesCropBackend gpu(2,1024*1024);gpu.Upload(image);
  ErpView first{512,256,60,64,64};auto before=ainvr::GetGlesCropStats();
  auto one=gpu.GetMap(image.size(),first);first.cx+=.1;
  auto same=gpu.GetMap(image.size(),first);EXPECT_EQ(one.get(),same.get());
  auto expected=gpu.Remap(one,{}, {32,32});
  first.cx+=100;gpu.GetMap(image.size(),first);first.cx+=100;gpu.GetMap(image.size(),first);
  EXPECT_EQ(gpu.CacheSize(),2u);EXPECT_EQ(gpu.CacheBytes(),2u*64*64*8);
  EXPECT_EQ(cv::norm(expected,gpu.Remap(one,{},expected.size()),cv::NORM_INF),0);
  EXPECT_EQ(ainvr::GetGlesCropStats().cache_hits,before.cache_hits+1);
}
TEST(SnapshotCropGles, CacheByteLimitEvictsButAlwaysRetainsNewestMap){
  auto image=Pattern({1024,512});ainvr::GlesCropBackend gpu(256,40000);gpu.Upload(image);
  ErpView view{512,256,60,64,64};auto first=gpu.GetMap(image.size(),view);
  auto expected=gpu.Remap(first,{}, {32,32});view.cx+=100;gpu.GetMap(image.size(),view);
  EXPECT_EQ(gpu.CacheSize(),1u);EXPECT_EQ(gpu.CacheBytes(),64u*64*8);
  EXPECT_EQ(cv::norm(expected,gpu.Remap(first,{},expected.size()),cv::NORM_INF),0);
  ainvr::GlesCropBackend tiny(256,1000);tiny.GetMap(image.size(),view);
  EXPECT_EQ(tiny.CacheSize(),1u);EXPECT_GT(tiny.CacheBytes(),1000u);
}
TEST(SnapshotCropGles, InvalidHardwareInputsAndMapOwnershipAreRejected){
  ainvr::GlesCropBackend gpu;auto image=Pattern({128,64});gpu.Upload(image);
  EXPECT_THROW(gpu.Upload(cv::Mat(64,128,CV_8UC3)),std::invalid_argument);
  EXPECT_THROW(gpu.Area({0,0,10,10},{0,10}),std::invalid_argument);
  EXPECT_THROW(gpu.Area({0,0,-1,10},{10,10}),std::invalid_argument);
  ErpView view{64,32,60,64,64};auto map=gpu.GetMap(image.size(),view);
  EXPECT_THROW(gpu.Remap(map,{-1,0},{32,32}),std::invalid_argument);
  auto fabricated=std::make_shared<ainvr::GlesErpMap>();fabricated->finite=true;
  EXPECT_THROW(gpu.Remap(fabricated,{}, {32,32}),std::invalid_argument);
  ainvr::GlesCropBackend other;other.Upload(image);
  EXPECT_THROW(other.Remap(map,{}, {32,32}),std::invalid_argument);
  view.cx=std::numeric_limits<double>::infinity();
  EXPECT_THROW(gpu.GetMap(image.size(),view),std::invalid_argument);
  view.cx=64;view.w_out=2049;view.h_out=2049;
  EXPECT_THROW(gpu.GetMap(image.size(),view),std::invalid_argument);
  EXPECT_THROW(CropWithPadding(image,{0,0,10,10},-.1,32,false),std::invalid_argument);
}
TEST(SnapshotCropGles, EmptyOrInvalidBatchDoesNotDownloadOrOpenGpu){
  auto image=Pattern({128,64});SnapshotCropper cropper;int downloads=0;
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){++downloads;dst=image(roi);}};
  config::SnapshotConfig cfg;cfg.projection_mode="erp_equirect";
  auto before=ainvr::GetGlesCropStats();EXPECT_TRUE(cropper.Crop(provider,{},false,cfg).empty());
  auto invalid=cropper.Crop(provider,{Detect({0,0,0,10})},false,cfg);
  ASSERT_EQ(invalid.size(),1u);EXPECT_TRUE(invalid[0].empty());EXPECT_EQ(downloads,0);
  EXPECT_EQ(ainvr::GetGlesCropStats().maps,before.maps);EXPECT_EQ(ainvr::GetGlesCropStats().crops,before.crops);
}
TEST(SnapshotCropGles, OriginalCropperDownloadsOneUnionAndSkipsInvalidTargets){
  auto image=Pattern({3840,1920});SnapshotCropper cropper;int downloads=0;cv::Rect downloaded;
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){
    ++downloads;downloaded=roi;dst=image(roi);
  }};
  config::SnapshotConfig cfg;cfg.max_crop_dimension=320;cfg.padding_ratio=.25;cfg.projection_mode="erp_equirect";
  std::vector<Detection> detections{Detect({1750,800,160,160}),Detect({1950,800,160,160}),
    Detect({0,0,0,10}),Detect({std::numeric_limits<double>::quiet_NaN(),0,10,10})};
  auto actual=cropper.Crop(provider,detections,false,cfg);
  ASSERT_EQ(actual.size(),4u);EXPECT_EQ(downloads,1);EXPECT_FALSE(cropper.full_frame());
  EXPECT_LT(cropper.downloaded_bytes(),image.total()*image.elemSize());EXPECT_EQ(cropper.invalid_count(),2u);
  EXPECT_TRUE(actual[2].empty());EXPECT_TRUE(actual[3].empty());
  for(int i=0;i<2;++i){auto view=BboxToErpView(detections[i].bbox,.25,image.cols,image.rows,320,9,false);
    ASSERT_TRUE(view);EXPECT_LE(cv::norm(actual[i],Reference(image,*view),cv::NORM_INF),4.);}
  // Provider remains synchronous and the result owns its pixels.
  auto saved=actual[0].clone();image.setTo(cv::Scalar::all(0));EXPECT_EQ(cv::norm(saved,actual[0],cv::NORM_INF),0);
}
TEST(SnapshotCropGles, LargeMapBatchUsesOriginalSequentialFullFrameBudgetFallback){
  cv::Mat image(2048,4096,CV_8UC4,cv::Scalar(40,90,170,200));SnapshotCropper cropper;int calls=0;
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){++calls;dst=image(roi);}};
  config::SnapshotConfig cfg;cfg.max_crop_dimension=1280;cfg.padding_ratio=.25;cfg.projection_mode="erp_equirect";
  std::vector<Detection> detections;
  for(int i=0;i<3;++i)detections.push_back(Detect({1000.+i*500,500,1000,1000}));
  auto results=cropper.Crop(provider,detections,true,cfg);
  ASSERT_EQ(results.size(),3u);EXPECT_EQ(calls,1);EXPECT_TRUE(cropper.full_frame());
  EXPECT_EQ(cropper.downloaded_bytes(),image.total()*4);
  for(auto& result:results){ASSERT_FALSE(result.empty());cv::Mat expected(result.size(),CV_8UC4,cv::Scalar(40,90,170,200));EXPECT_LE(cv::norm(result,expected,cv::NORM_INF),1.);}
}
TEST(SnapshotCropGles, ProductionCpuMapAndSamplingAreUnavailable){
  EXPECT_THROW(BuildErpMap(3840,1920,1920,960,60,320,320),std::runtime_error);
  EXPECT_THROW(SampleErpPerspective(cv::Mat(),cv::Mat(),cv::Mat()),std::runtime_error);
}
TEST(SnapshotCropGles, CallerContextAndParallelCropWorkersRemainUsable){
  ainvr::GlesPreprocessor images;ainvr::ImageTransform t;t.width=32;t.height=32;t.letterbox=false;
  std::vector<uint8_t> rgba(32*32*4,80);auto previous=images.Run(rgba,32,32,t);
  {ainvr::GlesCropBackend crop;crop.Upload(Pattern({32,32}));crop.Area({0,0,32,32},{16,16});}
  EXPECT_EQ(previous,images.Run(rgba,32,32,t));std::vector<std::future<cv::Mat>> workers;
  for(int i=0;i<4;++i)workers.push_back(std::async(std::launch::async,[]{
    auto image=Pattern({129,127});return CropWithPadding(image,{10,10,65,63},.25,64,true);
  }));
  auto reference=CropWithPaddingReference(Pattern({129,127}),{10,10,65,63},.25,64,true);
  for(auto& worker:workers)EXPECT_LE(cv::norm(worker.get(),reference,cv::NORM_INF),1.);
}
TEST(SnapshotCropGles, MissingGpuIsVisibleAndSameCropperCanRetry){
  auto job=std::async(std::launch::async,[]{
    const char* value=std::getenv("AINVR_DRM_RENDER_NODE");const bool existed=value!=nullptr;const std::string saved=value?value:"";
    struct Restore{bool existed;std::string value;~Restore(){if(existed)setenv("AINVR_DRM_RENDER_NODE",value.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");}}restore{existed,saved};
    auto image=Pattern({128,128});SnapshotCropper cropper;
    pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){dst=image(roi);}};
    config::SnapshotConfig cfg;cfg.max_crop_dimension=64;cfg.projection_mode="none";
    setenv("AINVR_DRM_RENDER_NODE","/nonexistent/ainvr-crop-test",1);
    EXPECT_THROW(cropper.Crop(provider,{Detect({10,10,60,60})},false,cfg),std::runtime_error);
    if(existed)setenv("AINVR_DRM_RENDER_NODE",saved.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");
    auto result=cropper.Crop(provider,{Detect({10,10,60,60})},false,cfg);ASSERT_FALSE(result[0].empty());
  });job.get();
}
TEST(SnapshotCropGles, ShortLivedBackendsReuseOnlyContextAndShaderWithIsolatedMaps){
  const auto outside=ainvr::GetGlesCropStats();
  auto job=std::async(std::launch::async,[]{
    const auto before=ainvr::GetGlesCropStats();auto image=Pattern({512,256},true);
    for(int i=0;i<20;++i){
      ainvr::GlesCropBackend gpu;gpu.Upload(image);
      auto got=gpu.Area({101,77,65,63},{32,31});
      auto expected=CropWithPaddingReference(image,{101,77,65,63},0,32,false);
      ASSERT_EQ(got.size(),expected.size());EXPECT_LE(cv::norm(got,expected,cv::NORM_INF),1.);
    }
    const auto warm=ainvr::GetGlesCropStats();
    EXPECT_EQ(warm.contexts_created,before.contexts_created+1);
    EXPECT_EQ(warm.shader_compilations,before.shader_compilations+1);
    EXPECT_EQ(warm.contexts_live,before.contexts_live+1);
    EXPECT_GE(warm.contexts_reused,before.contexts_reused+19);
    ainvr::GlesCropBackend first,second;
    first.Upload(image);second.Upload(image);
    ErpView a{256.25,128,72.25,65,63},b{258,128,72.5,65,63};
    auto map_a=first.GetMap(image.size(),a),map_b=second.GetMap(image.size(),b);
    EXPECT_NE(map_a.get(),map_b.get());
    EXPECT_THROW(second.Remap(map_a,{}, {65,63}),std::invalid_argument);
    auto actual_a=first.Remap(map_a,{}, {65,63});
    auto actual_b=second.Remap(map_b,{}, {65,63});
    auto [ax,ay]=BuildErpMapReference(512,256,a.cx,a.cy,a.fov_h_deg,65,63);
    auto [bx,by]=BuildErpMapReference(512,256,b.cx,b.cy,b.fov_h_deg,65,63);
    EXPECT_LE(cv::norm(actual_a,SampleErpPerspectiveReference(image,ax,ay),cv::NORM_INF),3.);
    EXPECT_LE(cv::norm(actual_b,SampleErpPerspectiveReference(image,bx,by),cv::NORM_INF),3.);
    EXPECT_GT(cv::norm(actual_a,actual_b,cv::NORM_INF),20.);
    EXPECT_EQ(first.GetMap(image.size(),b).get(),map_a.get()); // First view only in its own LRU.
  });job.get();
  for(int i=0;i<100 && ainvr::GetGlesCropStats().contexts_live!=outside.contexts_live;++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  EXPECT_EQ(ainvr::GetGlesCropStats().contexts_live,outside.contexts_live);
}
TEST(SnapshotCropGles, CachedContextCannotMaskUnavailableNewDeviceSelection){
  auto job=std::async(std::launch::async,[]{
    const char* value=std::getenv("AINVR_DRM_RENDER_NODE");const bool existed=value!=nullptr;const std::string saved=value?value:"";
    struct Restore{bool existed;std::string value;~Restore(){if(existed)setenv("AINVR_DRM_RENDER_NODE",value.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");}}restore{existed,saved};
    auto image=Pattern({128,128});
    {ainvr::GlesCropBackend gpu;gpu.Upload(image);gpu.Area({10,10,65,63},{65,63});}
    auto before=ainvr::GetGlesCropStats();
    setenv("AINVR_DRM_RENDER_NODE","/nonexistent/ainvr-cached-crop-test",1);
    EXPECT_THROW(ainvr::GlesCropBackend unavailable,std::runtime_error);
    if(existed)setenv("AINVR_DRM_RENDER_NODE",saved.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");
    ainvr::GlesCropBackend retry;retry.Upload(image);auto got=retry.Area({10,10,65,63},{65,63});
    EXPECT_EQ(ainvr::GetGlesCropStats().failures,before.failures+1);
    EXPECT_EQ(ainvr::GetGlesCropStats().contexts_created,before.contexts_created);
    EXPECT_EQ(ainvr::GetGlesCropStats().shader_compilations,before.shader_compilations);
    EXPECT_EQ(cv::norm(got,image(cv::Rect(10,10,65,63)),cv::NORM_INF),0);
  });job.get();
}
TEST(SnapshotCropGles, CropExposureAndJpuKeepEntirePixelPathOnHardware){
  cv::Mat source(128,128,CV_8UC4,cv::Scalar(40,40,40,91));
  auto before=ainvr::GetGlesCropStats();auto crop=CropWithPadding(source,{10,10,65,63},0,128,false);
  ASSERT_EQ(crop.size(),cv::Size(65,63));EXPECT_EQ(ainvr::GetGlesCropStats().crops,before.crops+1);
  auto corrected=CorrectExposureRgba(crop,220);std::vector<uint8_t> jpeg;
  ASSERT_TRUE(EncodeSnapshotRgbaJpeg(corrected,jpeg,95));auto decoded=cv::imdecode(jpeg,cv::IMREAD_COLOR);
  ASSERT_EQ(decoded.size(),crop.size());EXPECT_GE(cv::mean(decoded)[0],58);
  EXPECT_EQ(GetExposureBackendStats().cpu_runs,0);EXPECT_EQ(GetSnapshotJpegStats().cpu,0);
}
TEST(SnapshotCropGles, WarmErpCropPerformanceIncludesRegionDownloadAndReadback){
  auto image=Pattern({3840,1920});SnapshotCropper cropper;
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){dst=image(roi);}};
  config::SnapshotConfig cfg;cfg.max_crop_dimension=320;cfg.padding_ratio=.25;cfg.projection_mode="erp_equirect";
  auto detections=std::vector<Detection>{Detect({1700,700,200,200})};
  for(int i=0;i<3;++i)cropper.Crop(provider,detections,true,cfg);
  auto before=ainvr::GetGlesCropStats();auto start=std::chrono::steady_clock::now();
  for(int i=0;i<12;++i)cropper.Crop(provider,detections,true,cfg);
  auto after=ainvr::GetGlesCropStats();double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()/12;
  EXPECT_EQ(after.maps,before.maps);EXPECT_EQ(after.cache_hits,before.cache_hits+12);EXPECT_EQ(after.crops,before.crops+12);
  RecordProperty("warm_erp_4k_to_320_complete_call_ms",std::to_string(ms));
  RecordProperty("region_download_bytes",std::to_string(cropper.downloaded_bytes()));
}

TEST(SnapshotCropGles, PersistentExactViewsMatchFreshTargetPixelsAcrossMotion) {
  auto image=Pattern({1024,512},true);
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){dst=image(roi);}};
  config::SnapshotConfig cfg;cfg.projection_mode="erp_equirect";
  cfg.max_crop_dimension=96;cfg.padding_ratio=.25;
  SnapshotCropper persistent(true);
  auto before=ainvr::GetGlesCropStats();
  for(double offset:{0.,.1,.2,0.,.1}) {
    auto detection=Detect({400.+offset,200.,80.,100.});
    SnapshotCropper fresh;
    auto expected=fresh.Crop(provider,{detection},false,cfg);
    auto actual=persistent.Crop(provider,{detection},false,cfg);
    ASSERT_EQ(actual.size(),1u);ASSERT_FALSE(actual[0].empty());
    EXPECT_EQ(cv::norm(actual[0],expected[0],cv::NORM_INF),0);
  }
  EXPECT_GE(ainvr::GetGlesCropStats().cache_hits-before.cache_hits,2u);
}

TEST(SnapshotCropGles, ExactSharedUploadExperimentPreservesPixelsAndMeasuresBytes) {
  auto image=Pattern({3840,1920},true);
  config::SnapshotConfig cfg;cfg.projection_mode="erp_equirect";
  cfg.max_crop_dimension=320;cfg.padding_ratio=.25;
  for(bool scattered:{false,true}) {
    std::vector<Detection> detections;
    for(int i=0;i<8;++i) detections.push_back(Detect({double(scattered?200+i*420:1500+i*45),800.,120.,180.}));
    size_t downloaded=0;
    pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){downloaded+=size_t(roi.area())*4;dst=image(roi);}};
    SnapshotCropper singles(true),batch(true);
    auto combined=batch.Crop(provider,detections,false,cfg);
    ASSERT_EQ(combined.size(),detections.size());
    for(size_t i=0;i<detections.size();++i) {
      SnapshotCropper fresh;
      auto expected=fresh.Crop(provider,{detections[i]},false,cfg);
      EXPECT_EQ(cv::norm(combined[i],expected[0],cv::NORM_INF),0);
    }
    for(bool shared:{false,true}) {
      downloaded=0;
      auto begin=std::chrono::steady_clock::now();
      for(int n=0;n<12;++n) {
        if(shared) batch.Crop(provider,detections,false,cfg);
        else for(const auto& d:detections) singles.Crop(provider,{d},false,cfg);
      }
      const std::string prefix=std::string(scattered?"scattered":"clustered")+(shared?"_shared":"_separate");
      RecordProperty(prefix+"_ms_per_frame",std::to_string(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count()/12));
      RecordProperty(prefix+"_bytes_per_frame",std::to_string(downloaded/12));
    }
  }
}

TEST(SnapshotCropGles, PersistentWorkCapacityDoesNotLeakOldPixelsAcrossSizesOrFrames) {
  SnapshotCropper persistent(true);
  config::SnapshotConfig cfg;cfg.padding_ratio=.25;
  auto image=Pattern({1024,512},true);
  pipeline::SnapshotSink::FrameProvider provider{image.size(),[&](const cv::Rect& roi,cv::Mat& dst){dst=image(roi);}};
  for(int frame=0;frame<3;++frame) {
    if(frame) image.setTo(cv::Scalar(20*frame,80,150,255));
    for(const char* projection:{"erp_equirect","none"}) {
      cfg.projection_mode=projection;
      for(int size:{192,48,96,48,192}) {
        cfg.max_crop_dimension=size;
        auto detection=Detect({400.,160.,150.,180.});
        SnapshotCropper fresh;
        auto expected=fresh.Crop(provider,{detection},false,cfg);
        auto actual=persistent.Crop(provider,{detection},false,cfg);
        ASSERT_FALSE(actual[0].empty());
        EXPECT_EQ(cv::norm(actual[0],expected[0],cv::NORM_INF),0);
      }
    }
  }
}

TEST(SnapshotCropGles, DirectNv12MatchesRgbaIntermediateAndInvalidatesSourceCache) {
  ainvr::GlesPreprocessor converter;
  ainvr::GlesCropBackend actual(64,size_t(32)<<20,true),expected(64,size_t(32)<<20,true);
  uint64_t tag=0;
  for(auto size:{cv::Size(258,130),cv::Size(3840,1920),cv::Size(7680,3840)}) {
    std::vector<uint8_t> nv12(size_t(size.width)*size.height*3/2);
    cv::RNG rng(392);rng.fill(cv::Mat(1,int(nv12.size()),CV_8U,nv12.data()),cv::RNG::UNIFORM,0,256);
    for(bool bt709:{false,true})for(bool full:{false,true}) {
      ainvr::ImageTransform t;t.width=size.width;t.height=size.height;t.letterbox=false;
      t.yuv_bt709=bt709;t.yuv_full_range=full;
      const auto rgba=converter.RunNv12Rgba(nv12,size.width,size.height,t,++tag);
      cv::Mat image(size,CV_8UC4,const_cast<uint8_t*>(rgba.data()));expected.Upload(image);
      actual.UploadNv12(nv12,size,tag,bt709,full);
      // Repeating an immutable tag must preserve content and switch color flags safely.
      actual.UploadNv12(nv12,size,tag,bt709,full);
      for(cv::Rect rect:{cv::Rect(0,0,65,67),cv::Rect(-4,-3,65,67),cv::Rect(size.width-50,size.height-50,65,67)}) {
        const auto a=actual.Area(rect,{47,49}),b=expected.Area(rect,{47,49});
        EXPECT_LE(cv::norm(a,b,cv::NORM_INF),1.0);EXPECT_LE(MeanError(a,b),.05);
      }
      for(auto box:std::vector<std::array<double,4>>{{0,10,80,65},{size.width*.48,size.height*.45,90,73},{size.width-40.,size.height-35.,80,65}}){
        const auto view=BboxToErpView(box,.25,size.width,size.height,96,9,false);ASSERT_TRUE(view);
        auto ss=ScaleErpView(*view,1.5);
        const auto a=actual.Remap(actual.GetMap(size,ss),{}, {view->w_out,view->h_out});
        const auto b=expected.Remap(expected.GetMap(size,ss),{}, {view->w_out,view->h_out});
        EXPECT_LE(cv::norm(a,b,cv::NORM_INF),1.0);EXPECT_LE(MeanError(a,b),.05);
      }
      actual.Upload(image);EXPECT_EQ(cv::norm(actual.Area({0,0,32,32},{32,32}),expected.Area({0,0,32,32},{32,32}),cv::NORM_INF),0);
    }
  }
  EXPECT_THROW(actual.UploadNv12({}, {32,32},0,false,false),std::invalid_argument);
}

TEST(SnapshotCropGles, DirectNv12ProviderPreservesProductionRoiPixelsAndBenchmarks) {
  const cv::Size size(3840,1920);
  auto bytes=std::make_shared<std::vector<uint8_t>>(size_t(size.width)*size.height*3/2);
  cv::RNG rng(83);rng.fill(cv::Mat(1,int(bytes->size()),CV_8U,bytes->data()),cv::RNG::UNIFORM,0,256);
  ainvr::GlesPreprocessor converter;
  uint64_t tag=100;
  pipeline::SnapshotSink::FrameProvider old{size,[&](const cv::Rect& roi,cv::Mat& dst){
    ainvr::ImageTransform t;t.width=roi.width;t.height=roi.height;t.letterbox=false;
    t.yuv_bt709=true;t.yuv_full_range=false;
    t.source_region=std::array<float,4>{float(roi.x),float(roi.y),float(roi.width),float(roi.height)};
    auto rgba=converter.RunNv12Rgba(*bytes,size.width,size.height,t,tag);
    dst=cv::Mat(roi.size(),CV_8UC4,rgba.data()).clone();
  }};
  auto direct=old;direct.download=[](const cv::Rect&,cv::Mat&){throw std::runtime_error("Unexpected host intermediate");};
  direct.nv12={bytes,tag,true,false};
  config::SnapshotConfig cfg;cfg.padding_ratio=.25;cfg.max_crop_dimension=320;
  const std::vector<Detection> detections{Detect({0,10,180,165}),Detect({500.5,930.5,120,85}),
    Detect({1830,680,190,170}),Detect({2450,650,120,310}),Detect({3800,1850,80,65}),
    Detect({3100,400,130,150}),Detect({900,500,150,300}),Detect({1200,400,175,150})};
  SnapshotCropper a(true),b(true);
  for(const char* projection:{"none","erp_equirect"})for(bool square:{false,true}) {
    cfg.projection_mode=projection;
    for(const auto& det:detections) {
      auto expected=a.Crop(old,{det},square,cfg),actual=b.Crop(direct,{det},square,cfg);
      ASSERT_EQ(actual[0].size(),expected[0].size());
      EXPECT_LE(cv::norm(actual[0],expected[0],cv::NORM_INF),1.0);
      EXPECT_LE(MeanError(actual[0],expected[0]),.05);
      EXPECT_EQ(b.downloaded_bytes(),0u);
    }
  }
  cfg.projection_mode="erp_equirect";
  for(int pass=0;pass<4;++pass) {
    const bool use_direct=pass==1||pass==2;
    auto start=std::chrono::steady_clock::now();
    for(int frame=0;frame<10;++frame){
      ++tag;direct.nv12.tag=tag;
      for(const auto& det:detections) (use_direct?b:a).Crop(use_direct?direct:old,{det},false,cfg);
    }
    RecordProperty(std::string(use_direct?"direct":"old")+std::to_string(pass)+"_ms_per_frame",
      std::to_string(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()/10));
  }
}

// Copyright AINVR. Separate process so no previously cached GPU context can hide failure.
#include "output/snapshot_jpeg.hpp"
#include <gtest/gtest.h>
#include <cstdlib>
#include <opencv2/imgcodecs.hpp>
using namespace ai_service::output;
TEST(SnapshotJpuFailure, MissingGpuNeverFallsBackAndNextJobCanRetry) {
 const char* previous=std::getenv("AINVR_DRM_RENDER_NODE");
 const bool existed=previous!=nullptr;const std::string saved=previous?previous:"";
 struct Restore {bool existed;std::string saved;
  ~Restore(){if(existed)setenv("AINVR_DRM_RENDER_NODE",saved.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");}
 } restore{existed,saved};
 setenv("AINVR_DRM_RENDER_NODE","/dev/ainvr-jpeg-deliberately-absent",1);
 cv::Mat input(33,65,CV_8UC3,cv::Scalar(20,90,170));std::vector<uint8_t> jpeg;
 auto before=GetSnapshotJpegStats();
 EXPECT_THROW(EncodeSnapshotJpeg(input,jpeg,95),std::runtime_error);
 auto failed=GetSnapshotJpegStats();EXPECT_TRUE(jpeg.empty());
 EXPECT_EQ(failed.failures,before.failures+1);EXPECT_EQ(failed.jpu,before.jpu);
 EXPECT_EQ(failed.gpu_color,before.gpu_color);EXPECT_EQ(failed.cpu,0);
 if(existed)setenv("AINVR_DRM_RENDER_NODE",saved.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");
 // Retry through the native archive layout; both entry points share the same
 // worker, which must discard the failed GPU context rather than fall back.
 cv::Mat rgba(input.size(),CV_8UC4,cv::Scalar(170,90,20,7));
 ASSERT_TRUE(EncodeSnapshotRgbaJpeg(rgba,jpeg,95));auto passed=GetSnapshotJpegStats();
 EXPECT_EQ(passed.failures,failed.failures);EXPECT_EQ(passed.jpu,failed.jpu+1);
 EXPECT_EQ(passed.gpu_color,failed.gpu_color+1);EXPECT_EQ(passed.cpu,0);
 EXPECT_EQ(cv::imdecode(jpeg,cv::IMREAD_COLOR).size(),input.size());
}

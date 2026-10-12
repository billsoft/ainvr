// Legacy fixtures bound adjustment magnitude; the soft target constraint is
// intentionally more conservative. Image tests below protect tonal texture.
#include <gtest/gtest.h>

#include <fstream>
#include <set>
#include <chrono>
#include <cstdlib>

#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include "../../src/output/gpu_image.hpp"
#include "../../src/output/exposure_cuda.hpp"
#endif

#include "../../src/output/exposure.hpp"

using namespace ai_service::output;
using nlohmann::json;

namespace {
cv::Mat JsonToMat(const json& arr, int channels) {
  int h = static_cast<int>(arr.size());
  int w = static_cast<int>(arr[0].size());
  cv::Mat m(h, w, channels == 4 ? CV_8UC4 : CV_8UC3);
  for (int r = 0; r < h; ++r) {
    for (int c = 0; c < w; ++c) {
      for (int ch = 0; ch < channels; ++ch) {
        if (channels == 4) {
          m.at<cv::Vec4b>(r, c)[ch] = static_cast<uchar>(arr[r][c][ch].get<int>());
        } else {
          m.at<cv::Vec3b>(r, c)[ch] = static_cast<uchar>(arr[r][c][ch].get<int>());
        }
      }
    }
  }
  return m;
}

json LoadFixtures() {
  std::ifstream f(EXPOSURE_FIXTURES_PATH);
  json j;
  f >> j;
  return j;
}
}  // namespace

TEST(Exposure, LegacyFixturesBoundConservativeAdjustment) {
  json fixtures = LoadFixtures();
  for (auto&& c : fixtures["cases"]) {
    std::string name = c["name"].get<std::string>();
    bool is_rgba = c.value("rgba", false);
    int channels = is_rgba ? 4 : 3;
    cv::Mat input = JsonToMat(c["input"], channels);
    cv::Mat expected = JsonToMat(c["output"], channels);
    double target = c["target"].get<double>();
    double strength = c["strength"].get<double>();

    if (is_rgba) {
      cv::cvtColor(input, input, cv::COLOR_RGBA2BGR);
      cv::cvtColor(expected, expected, cv::COLOR_RGBA2BGR);
      channels = 3;
    }
    cv::Mat actual = CorrectExposure(input, target, strength, 1.5);

    ASSERT_EQ(actual.size(), expected.size()) << name;
    ASSERT_EQ(actual.type(), expected.type()) << name;
    // Soft correction must stay between the original and legacy correction,
    // allowing two code values for the reference's filter/LUT rounding.
    for (int r = 0; r < input.rows; ++r) {
      for (int i = 0; i < input.cols * channels; ++i) {
        int original = input.ptr<uchar>(r)[i];
        int legacy = expected.ptr<uchar>(r)[i];
        int value = actual.ptr<uchar>(r)[i];
        EXPECT_GE(value, std::min(original, legacy) - 2) << name;
        EXPECT_LE(value, std::max(original, legacy) + 2) << name;
      }
    }
  }
}

TEST(Exposure, ZeroStrengthReturnsExactCopy) {
  json fixtures = LoadFixtures();
  for (auto&& c : fixtures["cases"]) {
    if (c["name"] != "zero_strength_passthrough") continue;
    cv::Mat input = JsonToMat(c["input"], 3);
    cv::Mat actual = CorrectExposure(input, c["target"].get<double>(), 0.0);
    // strength=0 是精确恒等(直接 return img_bgr.copy()),不是近似,容差为 0。
    // NORM_INF 对多通道 Mat 直接可用(逐元素最大绝对差),等价"完全相同"。
    EXPECT_DOUBLE_EQ(cv::norm(actual, input, cv::NORM_INF), 0.0);
  }
}

TEST(Exposure, RgbaAlphaChannelExactlyPreserved) {
  json fixtures = LoadFixtures();
  for (auto&& c : fixtures["cases"]) {
    if (!c.value("rgba", false)) continue;
    cv::Mat input = JsonToMat(c["input"], 4);
    cv::Mat actual = CorrectExposureRgba(input, c["target"].get<double>(), c["strength"].get<double>());
    for (int r = 0; r < input.rows; ++r) {
      for (int col = 0; col < input.cols; ++col) {
        EXPECT_EQ(actual.at<cv::Vec4b>(r, col)[3], input.at<cv::Vec4b>(r, col)[3]);
      }
    }
  }
}

TEST(Exposure, InvalidInputTypeThrows) {
  cv::Mat wrong_type(10, 10, CV_32FC3);
  EXPECT_THROW(CorrectExposure(wrong_type, 128.0, 0.6), std::invalid_argument);
}

TEST(Exposure, EmptyInputThrows) {
  cv::Mat empty;
  EXPECT_THROW(CorrectExposure(empty, 128.0, 0.6), std::invalid_argument);
}

TEST(Exposure, OutOfRangeTargetThrows) {
  cv::Mat img(10, 10, CV_8UC3, cv::Scalar(50, 50, 50));
  EXPECT_THROW(CorrectExposure(img, 300.0, 0.6), std::invalid_argument);
}

TEST(Exposure, OutOfRangeStrengthThrows) {
  cv::Mat img(10, 10, CV_8UC3, cv::Scalar(50, 50, 50));
  EXPECT_THROW(CorrectExposure(img, 128.0, 1.5), std::invalid_argument);
}

TEST(Exposure, DarkImageWithBrightTargetIncreasesMeanBrightness) {
  cv::Mat img(32, 32, CV_8UC3, cv::Scalar(20, 20, 20));
  cv::Mat out = CorrectExposure(img, 200.0, 0.6);
  EXPECT_GT(cv::mean(out)[0], cv::mean(img)[0]);
}

TEST(Exposure, BrightImageWithDimTargetDecreasesMeanBrightness) {
  cv::Mat img(32, 32, CV_8UC3, cv::Scalar(240, 240, 240));
  cv::Mat out = CorrectExposure(img, 100.0, 0.6);
  EXPECT_LT(cv::mean(out)[0], cv::mean(img)[0]);
}

TEST(Exposure, MidtoneTextureSurvivesLocalCorrection) {
  // A thin texture stripe shares the illumination of its surrounding face.
  // The old target clamp collapses these distinct samples to one grey level.
  for (bool brighten : {true, false}) {
    cv::Mat input(128, 128, CV_8UC3,
                  cv::Scalar::all(brighten ? 40 : 220));
    int first = brighten ? 100 : 124;
    int count = brighten ? 19 : 37;
    for (int i = 0; i < count; ++i)
      input.at<cv::Vec3b>(64, 40 + i) = cv::Vec3b::all(first + i);
    auto output = CorrectExposure(input, 128);
    std::set<int> levels;
    for (int i = 0; i < count; ++i)
      levels.insert(output.at<cv::Vec3b>(64, 40 + i)[0]);
    EXPECT_GE(levels.size(), 8u) << "brighten=" << brighten;
    RecordProperty(brighten ? "bright_texture_levels" : "dark_texture_levels",
                   static_cast<int>(levels.size()));
  }
}

TEST(Exposure, GradientKeepsEndpointsAndDirection) {
  cv::Mat input(32, 256, CV_8UC3);
  for (int r = 0; r < input.rows; ++r)
    for (int v = 0; v < 256; ++v)
      input.at<cv::Vec3b>(r, v) = cv::Vec3b::all(v);
  for (double target : {0., 80., 128., 180., 255.}) {
    auto output = CorrectExposure(input, target);
    for (int v = 1; v < 255; ++v) {
      int actual = output.at<cv::Vec3b>(16, v)[0];
      EXPECT_GE(actual, 1);
      EXPECT_LE(actual, 254);
      if (target == 0.) EXPECT_LE(actual, v);
      if (target == 255.) EXPECT_GE(actual, v);
    }
    EXPECT_EQ(output.at<cv::Vec3b>(16, 0)[0], 0);
  }
}

TEST(Exposure, OptionalCpuBenchmark) {
  if (!std::getenv("TECHE_EXPOSURE_BENCH")) GTEST_SKIP();
  cv::Mat input(320, 320, CV_8UC3);
  cv::RNG rng(123);
  rng.fill(input, cv::RNG::UNIFORM, 0, 256);
  for (int i = 0; i < 3; ++i) CorrectExposure(input);
  auto start = std::chrono::steady_clock::now();
  for (int i = 0; i < 20; ++i) CorrectExposure(input);
  auto ms = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - start).count() / 20;
  RecordProperty("mean_ms_320", ms);
}

TEST(Exposure, DarkFaceGetsUsefulLiftWithoutLiftingBlack) {
  cv::Mat dark(64, 64, CV_8UC3, cv::Scalar::all(40));
  auto corrected = CorrectExposure(dark, 220);
  EXPECT_GE(cv::mean(corrected)[0], 58);
  EXPECT_LE(cv::mean(corrected)[0], 80);
  cv::Mat black(64, 64, CV_8UC3, cv::Scalar::all(0));
  EXPECT_EQ(cv::countNonZero(CorrectExposure(black, 220).reshape(1)), 0);
}

TEST(Exposure, ExplicitExposureCapStillRespected) {
  cv::Mat dark(64, 64, CV_8UC3, cv::Scalar::all(40));
  auto limited = CorrectExposure(dark, 220, 0.6, 1.5);
  EXPECT_LE(cv::mean(limited)[0], 55);
  EXPECT_GT(cv::mean(CorrectExposure(dark, 220))[0], cv::mean(limited)[0]);
}

// CUDA-only cases remain for reference; S100P acceleration needs its own execution proof.
#ifdef AINVR_CUDA_REFERENCE_TESTS
TEST(Exposure, AcceleratedPixelsMatchCpuAcrossSizesAndTargets) {
  if (!GpuAvailable()) GTEST_SKIP();
  cv::RNG rng(123);
  for (auto size : {cv::Size(256,256), cv::Size(513,259), cv::Size(300,280)}) {
    cv::Mat backing(size.height+4,size.width+4,CV_8UC3);
    rng.fill(backing,cv::RNG::UNIFORM,0,256);
    auto input=backing(cv::Rect(1,1,size.width,size.height));
    for (double target : {0.,128.,220.,255.}) {
      auto reference=CorrectExposure(input,target,.6,3.,.1,.8,.2,false);
      auto actual=CorrectExposure(input,target);
      EXPECT_LE(cv::norm(reference,actual,cv::NORM_INF),1.0);
    }
  }
}

TEST(Exposure, CudaBackendActuallyExecutes) {
  if (!GpuAvailable()) GTEST_SKIP();
  cv::Mat input(256,256,CV_8UC3,cv::Scalar::all(40)), output;
  auto base = +[](const cv::Mat& log, double, double) { return log.clone(); };
  ASSERT_TRUE(TryExposureCuda(input,output,-1.f,.6f,3.f,.2f,.1,.8,base));
  EXPECT_GT(cv::mean(output)[0],40);
  EXPECT_LT(cv::mean(output)[0],100);
}

#endif

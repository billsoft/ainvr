#include <gtest/gtest.h>

#include <cmath>
#include <fstream>
#include <nlohmann/json.hpp>

#include "../../src/pipeline/postprocessor.hpp"
#include "../../src/pipeline/scale_info.hpp"

using ai_service::Detection;
using ai_service::pipeline::Box;
using ai_service::pipeline::ScaleInfo;

namespace {

nlohmann::json load_fixtures() {
  std::ifstream f(POSTPROCESS_FIXTURES_PATH);
  if (!f) {
    ADD_FAILURE() << "无法打开 fixture 文件: " << POSTPROCESS_FIXTURES_PATH;
    return {};
  }
  nlohmann::json j;
  f >> j;
  return j;
}

}  // namespace

// ========== 1. 手写用例:简单坐标变换,风险相对小 ==========

TEST(Postprocessor, ClipBoxesToBounds) {
  std::vector<Box> boxes = {{-10, -5, 700, 500}, {50, 50, 100, 100}};
  auto clipped = ai_service::pipeline::clip_boxes(boxes, 640, 480);
  EXPECT_DOUBLE_EQ(clipped[0][0], 0.0);
  EXPECT_DOUBLE_EQ(clipped[0][1], 0.0);
  EXPECT_DOUBLE_EQ(clipped[0][2], 640.0);
  EXPECT_DOUBLE_EQ(clipped[0][3], 480.0);
  EXPECT_EQ(clipped[1], (Box{50, 50, 100, 100}));
}

// xyxy2xywh 和 xywh2xyxy 不是互逆的(见 postprocessor.hpp 里的警告注释:
// 两者对"xywh"里 x,y 的含义约定不同,左上角 vs 中心点)——分开验证,不假设
// 往返相等。这个假设错误的版本之前真的写过一次,被这个测试自己的失败
// 揪出来过,不是凭空加的防御性注释。
TEST(Postprocessor, Xyxy2XywhProducesTopLeftFormat) {
  std::vector<Box> xyxy = {{10, 20, 110, 220}};
  auto xywh = ai_service::pipeline::xyxy2xywh(xyxy);
  EXPECT_EQ(xywh[0], (Box{10, 20, 100, 200}));  // 左上角 x,y + 宽高
}

TEST(Postprocessor, Xywh2XyxyAssumesCenterFormat) {
  std::vector<Box> xywh_center = {{60, 120, 100, 200}};  // 中心点 cx,cy + 宽高
  auto xyxy = ai_service::pipeline::xywh2xyxy(xywh_center);
  EXPECT_EQ(xyxy[0], (Box{10, 20, 110, 220}));
}

TEST(Postprocessor, RescaleDetectionsNoopAtScaleOne) {
  std::vector<Detection> dets = {
      {0, "person", 0.9, {1, 2, 3, 4}, std::nullopt},
  };
  auto out = ai_service::pipeline::rescale_detections(dets, 1.0, 1.0);
  EXPECT_EQ(out[0].bbox, dets[0].bbox);
}

TEST(Postprocessor, RescaleDetectionsScalesBboxAndLandmarks) {
  std::vector<Detection> dets = {
      {0, "face", 0.9, {10, 20, 30, 40}, std::vector<std::array<double, 2>>{{5, 5}}},
  };
  auto out = ai_service::pipeline::rescale_detections(dets, 2.0, 3.0);
  EXPECT_EQ(out[0].bbox, (Box{20, 60, 60, 120}));
  ASSERT_TRUE(out[0].landmarks.has_value());
  EXPECT_DOUBLE_EQ((*out[0].landmarks)[0][0], 10.0);
  EXPECT_DOUBLE_EQ((*out[0].landmarks)[0][1], 15.0);
}

// ========== 2. 对拍真实 Python numpy 实现的输出 ==========

TEST(PostprocessFixtures, ComputeScaleMatchesPython) {
  auto fixtures = load_fixtures();
  for (auto& c : fixtures.at("scale_cases")) {
    SCOPED_TRACE(c.dump());
    ScaleInfo si = ai_service::pipeline::compute_scale(
        c.at("orig_w").get<int>(), c.at("orig_h").get<int>(),
        c.at("target_w").get<int>(), c.at("target_h").get<int>());
    EXPECT_NEAR(si.scale, c.at("scale").get<double>(), 1e-12);
    EXPECT_EQ(si.pad_left, c.at("pad_left").get<int>());
    EXPECT_EQ(si.pad_top, c.at("pad_top").get<int>());
    EXPECT_EQ(si.new_w, c.at("new_w").get<int>());
    EXPECT_EQ(si.new_h, c.at("new_h").get<int>());
  }
}

TEST(PostprocessFixtures, NmsMatchesPython) {
  auto fixtures = load_fixtures();
  for (auto& c : fixtures.at("nms_cases")) {
    std::string name = c.at("name").get<std::string>();
    SCOPED_TRACE(name);

    std::vector<Box> boxes;
    for (auto& b : c.at("boxes")) {
      boxes.push_back({b.at(0).get<double>(), b.at(1).get<double>(),
                        b.at(2).get<double>(), b.at(3).get<double>()});
    }
    std::vector<double> scores;
    for (auto& s : c.at("scores")) scores.push_back(s.get<double>());

    auto keep = ai_service::pipeline::nms(boxes, scores, c.at("iou_th").get<double>());

    std::vector<int64_t> expect_keep;
    for (auto& k : c.at("keep")) expect_keep.push_back(k.get<int64_t>());
    EXPECT_EQ(keep, expect_keep);
  }
}

TEST(PostprocessFixtures, ScaleBoxesMatchesPython) {
  auto fixtures = load_fixtures();
  for (auto& c : fixtures.at("scale_boxes_cases")) {
    std::string name = c.at("name").get<std::string>();
    SCOPED_TRACE(name);

    auto args = c.at("scale_info_args");
    ScaleInfo si = ai_service::pipeline::compute_scale(
        args.at(0).get<int>(), args.at(1).get<int>(), args.at(2).get<int>(),
        args.at(3).get<int>());

    std::vector<Box> boxes;
    for (auto& b : c.at("boxes_xyxy")) {
      boxes.push_back({b.at(0).get<double>(), b.at(1).get<double>(),
                        b.at(2).get<double>(), b.at(3).get<double>()});
    }
    auto result = ai_service::pipeline::scale_boxes(boxes, si);

    auto& expect = c.at("result");
    ASSERT_EQ(result.size(), expect.size());
    for (size_t i = 0; i < result.size(); ++i) {
      for (int k = 0; k < 4; ++k) {
        EXPECT_NEAR(result[i][k], expect[i].at(k).get<double>(), 1e-9)
            << "box " << i << " coord " << k;
      }
    }
  }
}

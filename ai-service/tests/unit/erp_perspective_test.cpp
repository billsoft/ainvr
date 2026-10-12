// 对应 Python output/erp_perspective.py。核心验证是对照 v1 真实算法生成
// 的 golden fixture(erp_fixtures.json,由 gen_erp_fixture.py 在板上真实
// 跑 v1 bbox_to_erp_view/build_erp_map/sample_erp_perspective 生成)。
#include <gtest/gtest.h>

#include <fstream>

#include <nlohmann/json.hpp>

#include "../../src/output/erp_perspective.hpp"

using namespace ai_service::output;
using nlohmann::json;

namespace {
json LoadFixtures() {
  std::ifstream f(ERP_FIXTURES_PATH);
  json j;
  f >> j;
  return j;
}

cv::Mat JsonToBgrMat(const json& arr) {
  int h = static_cast<int>(arr.size());
  int w = static_cast<int>(arr[0].size());
  cv::Mat m(h, w, CV_8UC3);
  for (int r = 0; r < h; ++r) {
    for (int c = 0; c < w; ++c) {
      for (int ch = 0; ch < 3; ++ch) m.at<cv::Vec3b>(r, c)[ch] = static_cast<uchar>(arr[r][c][ch].get<int>());
    }
  }
  return m;
}

const json* FindCase(const json& fixtures, const std::string& name) {
  for (auto&& c : fixtures["cases"]) {
    if (c["name"] == name) return &c;
  }
  return nullptr;
}
}  // namespace

TEST(ErpPerspective, EquatorFaceMatchesGolden) {
  json fixtures = LoadFixtures();
  const json* c = FindCase(fixtures, "equator_face");
  ASSERT_NE(c, nullptr);
  auto bbox = (*c)["bbox"];
  std::array<double, 4> bb = {bbox[0], bbox[1], bbox[2], bbox[3]};

  auto view = BboxToErpView(bb, (*c)["padding_ratio"].get<double>(), (*c)["erp_w"].get<int>(),
                             (*c)["erp_h"].get<int>(), (*c)["max_dimension"].get<int>());
  ASSERT_TRUE(view.has_value());
  const auto& expected = (*c)["view"];
  EXPECT_NEAR(view->cx, expected["cx"].get<double>(), 1e-6);
  EXPECT_NEAR(view->cy, expected["cy"].get<double>(), 1e-6);
  EXPECT_NEAR(view->fov_h_deg, expected["fov_h_deg"].get<double>(), 1e-6);
  EXPECT_EQ(view->w_out, expected["w_out"].get<int>());
  EXPECT_EQ(view->h_out, expected["h_out"].get<int>());
}

TEST(ErpPerspective, HighLatitudeMatchesGolden) {
  json fixtures = LoadFixtures();
  const json* c = FindCase(fixtures, "high_latitude");
  ASSERT_NE(c, nullptr);
  auto bbox = (*c)["bbox"];
  std::array<double, 4> bb = {bbox[0], bbox[1], bbox[2], bbox[3]};

  auto view = BboxToErpView(bb, (*c)["padding_ratio"].get<double>(), (*c)["erp_w"].get<int>(),
                             (*c)["erp_h"].get<int>(), (*c)["max_dimension"].get<int>());
  ASSERT_TRUE(view.has_value());
  const auto& expected = (*c)["view"];
  EXPECT_NEAR(view->fov_h_deg, expected["fov_h_deg"].get<double>(), 1e-6)
      << "高纬度非线性密度换算是最容易出错的一步";
  EXPECT_EQ(view->w_out, expected["w_out"].get<int>());
  EXPECT_EQ(view->h_out, expected["h_out"].get<int>());
}

TEST(ErpPerspective, SquareModeMatchesGolden) {
  json fixtures = LoadFixtures();
  const json* c = FindCase(fixtures, "square_face");
  ASSERT_NE(c, nullptr);
  auto bbox = (*c)["bbox"];
  std::array<double, 4> bb = {bbox[0], bbox[1], bbox[2], bbox[3]};

  auto view = BboxToErpView(bb, (*c)["padding_ratio"].get<double>(), (*c)["erp_w"].get<int>(),
                             (*c)["erp_h"].get<int>(), (*c)["max_dimension"].get<int>(), 9,
                             /*square=*/true);
  ASSERT_TRUE(view.has_value());
  const auto& expected = (*c)["view"];
  EXPECT_EQ(view->w_out, view->h_out);  // square 模式:输出必须是正方形
  EXPECT_EQ(view->w_out, expected["w_out"].get<int>());
  EXPECT_NEAR(view->fov_h_deg, expected["fov_h_deg"].get<double>(), 1e-6);
}

TEST(ErpPerspective, ScaleErpViewPreservesAspectRatio) {
  json fixtures = LoadFixtures();
  const json* c = FindCase(fixtures, "supersample_1_5x");
  ASSERT_NE(c, nullptr);
  const auto& base = (*c)["base_view"];
  ErpView view{base["cx"], base["cy"], base["fov_h_deg"], base["w_out"].get<int>(),
               base["h_out"].get<int>()};

  auto scaled = ScaleErpView(view, (*c)["factor"].get<double>());
  const auto& expected = (*c)["scaled_view"];
  EXPECT_EQ(scaled.w_out, expected["w_out"].get<int>());
  EXPECT_EQ(scaled.h_out, expected["h_out"].get<int>());
}

TEST(ErpPerspective, DegenerateBboxReturnsNullopt) {
  std::array<double, 4> bad_bbox = {10.0, 10.0, 0.0, 5.0};  // 宽为 0
  auto view = BboxToErpView(bad_bbox, 0.25, 640, 320, 320);
  EXPECT_FALSE(view.has_value());
}

TEST(ErpPerspective, FullPipelineSampleMatchesGoldenWithinTolerance) {
  json fixtures = LoadFixtures();
  const json* c = FindCase(fixtures, "full_pipeline_sample");
  ASSERT_NE(c, nullptr);
  cv::Mat erp_img = JsonToBgrMat((*c)["erp_image"]);
  const auto& v = (*c)["view"];
  int erp_w = fixtures["erp_w"].get<int>();
  int erp_h = fixtures["erp_h"].get<int>();

  auto [map_x, map_y] = BuildErpMap(erp_w, erp_h, v["cx"].get<double>(), v["cy"].get<double>(),
                                     v["fov_h_deg"].get<double>(), v["w_out"].get<int>(),
                                     v["h_out"].get<int>());

  cv::Mat sampled = SampleErpPerspective(erp_img, map_x, map_y);
  cv::Mat expected = JsonToBgrMat((*c)["sampled_output"]);

  ASSERT_EQ(sampled.size(), expected.size());
  cv::Mat diff;
  cv::absdiff(sampled, expected, diff);
  cv::Scalar mean_diff = cv::mean(diff);
  // remap 是同一份 OpenCV C++ 实现(Python cv2.remap 也是调用它),数学公式
  // 完全对齐,理论上应该非常接近;容差覆盖 map_x/map_y 浮点路径(numpy
  // 向量化 vs 逐像素循环)可能有的极小误差累积。
  EXPECT_LT((mean_diff[0] + mean_diff[1] + mean_diff[2]) / 3.0, 3.0);
}

TEST(ErpMapCacheTest, CacheHitReturnsSameMapWithoutRebuilding) {
  ErpMapCache cache;
  ErpView view{300.0, 170.0, 34.0, 59, 90};
  auto [mx1, my1] = cache.GetOrBuild(640, 320, view);
  EXPECT_EQ(cache.Size(), 1u);
  auto [mx2, my2] = cache.GetOrBuild(640, 320, view);  // 同一量化桶,应该命中缓存
  EXPECT_EQ(cache.Size(), 1u);
  EXPECT_EQ(cv::norm(mx1, mx2, cv::NORM_INF), 0.0);
}

TEST(ErpMapCacheTest, DifferentViewsProduceDifferentCacheEntries) {
  ErpMapCache cache;
  cache.GetOrBuild(640, 320, ErpView{300.0, 170.0, 34.0, 59, 90});
  cache.GetOrBuild(640, 320, ErpView{100.0, 50.0, 20.0, 40, 60});
  EXPECT_EQ(cache.Size(), 2u);
}

TEST(ErpMapCacheTest, LruEvictsOldestWhenOverCapacity) {
  ErpMapCache cache(/*bucket_deg=*/3.0, /*max_entries=*/2);
  cache.GetOrBuild(640, 320, ErpView{100.0, 100.0, 20.0, 30, 30});
  cache.GetOrBuild(640, 320, ErpView{200.0, 100.0, 20.0, 30, 30});
  cache.GetOrBuild(640, 320, ErpView{300.0, 100.0, 20.0, 30, 30});  // 应挤掉第一个
  EXPECT_EQ(cache.Size(), 2u);
}

// 缓存按字节封顶，不能只按条数：截图上限 640、超采样 1.5 倍时每条映射表约 7.4MB，
// 256 条就是约 1.9GB（2026-09-30 8K 实测 AI 进程多占约 0.9GB）。人会动、脸大小各异，
// 几乎每张截图都是新键，命中率接近 0，大缓存只是白占内存。
TEST(ErpMapCacheTest, DefaultCacheIsBoundedByBytesNotJustEntryCount) {
  ErpMapCache cache;  // SnapshotStore 用的就是默认构造
  const size_t per_entry = size_t(960) * 960 * sizeof(float) * 2;  // map_x + map_y
  for (int i = 0; i < 40; ++i) {
    cache.GetOrBuild(7680, 3840, ErpView{100.0 + i * 150.0, 1920.0, 20.0, 960, 960});
  }
  EXPECT_LE(cache.Size() * per_entry, size_t(64) << 20) << "缓存条数 " << cache.Size();
  EXPECT_GE(cache.Size(), 1u);
}

TEST(ErpMapCacheTest, SingleEntryLargerThanBudgetIsStillReturnedAndKept) {
  ErpMapCache cache(/*bucket_deg=*/3.0, /*max_entries=*/256, /*max_bytes=*/1024);
  auto [mx, my] = cache.GetOrBuild(640, 320, ErpView{300.0, 170.0, 34.0, 59, 90});
  EXPECT_EQ(mx.cols, 59);
  EXPECT_EQ(cache.Size(), 1u);  // 最新一条总保留，淘汰的是更旧的
  cache.GetOrBuild(640, 320, ErpView{100.0, 50.0, 20.0, 40, 60});
  EXPECT_EQ(cache.Size(), 1u);
}

// 对应 Python output/result_buffer.py 的行为测试。
#include <gtest/gtest.h>

#include "../../src/output/result_buffer.hpp"

using ai_service::FrameResult;
using ai_service::ResultBuffer;

namespace {
FrameResult MakeResult(int64_t frame_index) {
  FrameResult r;
  r.frame_index = frame_index;
  return r;
}
}  // namespace

TEST(ResultBuffer, EmptyBufferLatestIsNullopt) {
  ResultBuffer buf(3);
  EXPECT_FALSE(buf.Latest().has_value());
  EXPECT_EQ(buf.Size(), 0u);
}

TEST(ResultBuffer, AppendAndLatest) {
  ResultBuffer buf(3);
  buf.Append(MakeResult(1));
  buf.Append(MakeResult(2));
  ASSERT_TRUE(buf.Latest().has_value());
  EXPECT_EQ(buf.Latest()->frame_index, 2);
  EXPECT_EQ(buf.Size(), 2u);
}

TEST(ResultBuffer, RingEvictsOldestWhenFull) {
  ResultBuffer buf(2);
  buf.Append(MakeResult(1));
  buf.Append(MakeResult(2));
  buf.Append(MakeResult(3));  // 应该挤掉 1
  EXPECT_EQ(buf.Size(), 2u);
  auto all = buf.All();
  ASSERT_EQ(all.size(), 2u);
  EXPECT_EQ(all[0].frame_index, 2);
  EXPECT_EQ(all[1].frame_index, 3);
}

TEST(ResultBuffer, LastNReturnsAscendingOrder) {
  ResultBuffer buf(10);
  for (int i = 1; i <= 5; ++i) buf.Append(MakeResult(i));
  auto last3 = buf.LastN(3);
  ASSERT_EQ(last3.size(), 3u);
  EXPECT_EQ(last3[0].frame_index, 3);
  EXPECT_EQ(last3[1].frame_index, 4);
  EXPECT_EQ(last3[2].frame_index, 5);
}

TEST(ResultBuffer, LastNClampsToAvailableSize) {
  ResultBuffer buf(10);
  buf.Append(MakeResult(1));
  auto last = buf.LastN(100);
  EXPECT_EQ(last.size(), 1u);
}

TEST(ResultBuffer, ClearEmptiesBuffer) {
  ResultBuffer buf(10);
  buf.Append(MakeResult(1));
  buf.Clear();
  EXPECT_EQ(buf.Size(), 0u);
  EXPECT_FALSE(buf.Latest().has_value());
}

TEST(ResultBuffer, ResizeShrinksAndKeepsNewest) {
  ResultBuffer buf(10);
  for (int i = 1; i <= 5; ++i) buf.Append(MakeResult(i));
  buf.Resize(2);
  auto all = buf.All();
  ASSERT_EQ(all.size(), 2u);
  EXPECT_EQ(all[0].frame_index, 4);
  EXPECT_EQ(all[1].frame_index, 5);
}

TEST(ResultBuffer, ResizeGrowsWithoutLosingData) {
  ResultBuffer buf(2);
  buf.Append(MakeResult(1));
  buf.Append(MakeResult(2));
  buf.Resize(5);
  buf.Append(MakeResult(3));
  EXPECT_EQ(buf.Size(), 3u);
}

// Copyright AINVR. Requires the user-provided fixed 640 SCRFD model.
#include "platform/onnx_model.hpp"
#include <gtest/gtest.h>
#include <cmath>
#include <limits>
using namespace ainvr;
TEST(OnnxModel, ValidatesInputAndOwnsOutputBuffers){
  OnnxModel model(SCRFD_TEST_MODEL,2);
  EXPECT_EQ(model.InputShape(),(std::vector<int64_t>{1,3,640,640}));
  EXPECT_THROW(model.Run({0}),std::invalid_argument);
  std::vector<float> input(3*640*640,0);input[0]=std::numeric_limits<float>::quiet_NaN();
  EXPECT_THROW(model.Run(input),std::invalid_argument);input[0]=0;
  auto first=model.Run(input);ASSERT_EQ(first.size(),9);auto first_values=first[0].values;
  std::fill(input.begin(),input.end(),.75f);auto second=model.Run(input);ASSERT_EQ(second.size(),9);
  EXPECT_EQ(first[0].values,first_values); // no aliases to a subsequent Run's storage
  size_t count=0;for(const auto& output:first){for(float value:output.values)ASSERT_TRUE(std::isfinite(value));count+=output.values.size();}
  EXPECT_EQ(count,252000);
}
TEST(OnnxModel, RejectsDynamicSourceAndBadThreadBudget){
  EXPECT_THROW(OnnxModel(SCRFD_DYNAMIC_TEST_MODEL),std::invalid_argument);
  EXPECT_THROW(OnnxModel(SCRFD_TEST_MODEL,0),std::invalid_argument);
}

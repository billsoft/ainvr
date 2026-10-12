#include "platform/tensor_decode.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <gtest/gtest.h>
TEST(TensorDecode, PaddedPerAxisQuantization){
  nlohmann::json d={{"shape",{2,3}},{"byte_strides",{8,1}},{"aligned_bytes",16},
    {"dtype_id",HB_DNN_TENSOR_TYPE_S8},{"quantization",SCALE},{"quantize_axis",1},
    {"scales",{0.5,1.,2.}},{"zero_points",{1,2,3}}};
  std::vector<unsigned char> bytes(16,0);bytes[0]=3;bytes[1]=4;bytes[2]=5;bytes[8]=255;bytes[9]=0;bytes[10]=1;
  EXPECT_EQ(ainvr::DecodeTensor(bytes,d),(std::vector<float>{1,2,4,-1,-2,-4}));
  d["aligned_bytes"]=8;EXPECT_THROW(ainvr::DecodeTensor(bytes,d),std::invalid_argument);
}
TEST(TensorDecode, HalfPrecision){
  nlohmann::json d={{"shape",{2}},{"byte_strides",{2}},{"aligned_bytes",4},
    {"dtype_id",HB_DNN_TENSOR_TYPE_F16},{"quantization",NONE},{"quantize_axis",0},
    {"scales",nlohmann::json::array()},{"zero_points",nlohmann::json::array()}};
  EXPECT_EQ(ainvr::DecodeTensor({0,60,0,192},d),(std::vector<float>{1,-2}));
}

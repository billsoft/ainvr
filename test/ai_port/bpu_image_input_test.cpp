// Copyright AINVR. Byte packing, padded strides, and production fallback guard.
#include "platform/bpu_image_input.hpp"
#include "platform/image_preprocessor.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <gtest/gtest.h>
#include <cstring>
#include <limits>
using nlohmann::json;
namespace {
json Descriptor(int dtype,std::vector<int> shape,std::vector<int> strides,int bytes) {
  return {{"dtype_id",dtype},{"quantization",NONE},{"shape",shape},
          {"byte_strides",strides},{"aligned_bytes",bytes}};
}
json FloatDescriptor() {
  return Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,3,2,3},{96,32,16,4},96);
}
json Nv12Descriptors() {
  return json::array({Descriptor(HB_DNN_TENSOR_TYPE_U8,{1,4,4,1},{32,8,1,1},32),
                     Descriptor(HB_DNN_TENSOR_TYPE_U8,{1,2,2,2},{16,8,2,1},16)});
}
}
TEST(BpuImageInput, FloatRowsAndChannelsHonorSdkPadding) {
  std::vector<float> values(18);for(size_t i=0;i<values.size();++i)values[i]=i+.25f;
  auto packed=ainvr::PackBpuFloatNchw(values,FloatDescriptor());
  ASSERT_EQ(packed.size(),96u);
  for(int c=0;c<3;++c)for(int y=0;y<2;++y){
    for(int x=0;x<3;++x){float value;std::memcpy(&value,packed.data()+c*32+y*16+x*4,4);
      EXPECT_FLOAT_EQ(value,values[c*6+y*3+x]);}
    for(int i=12;i<16;++i)EXPECT_EQ(packed[c*32+y*16+i],0);
  }
}
TEST(BpuImageInput, Nv12PlanesHonorSdkPaddingAndUvOrdering) {
  std::vector<uint8_t> pixels(24);for(size_t i=0;i<pixels.size();++i)pixels[i]=i+1;
  auto packed=ainvr::PackBpuNv12(pixels,4,4,Nv12Descriptors());
  ASSERT_EQ(packed.size(),2u);
  for(int plane=0;plane<2;++plane)for(int row=0;row<(plane?2:4);++row){
    for(int x=0;x<4;++x)EXPECT_EQ(packed[plane][row*8+x],pixels[(plane?16:0)+row*4+x]);
    for(int x=4;x<8;++x)EXPECT_EQ(packed[plane][row*8+x],0);
  }
}
TEST(BpuImageInput, RejectsWrongDtypeQuantizationAndPacking) {
  auto d=FloatDescriptor();std::vector<float> values(18);
  d["dtype_id"]=HB_DNN_TENSOR_TYPE_U8;
  EXPECT_THROW(ainvr::PackBpuFloatNchw(values,d),std::invalid_argument);
  d=FloatDescriptor();d["quantization"]=SCALE;
  EXPECT_THROW(ainvr::PackBpuFloatNchw(values,d),std::invalid_argument);
  EXPECT_THROW(ainvr::PackBpuFloatNchw(std::vector<float>(17),FloatDescriptor()),std::invalid_argument);
  auto planes=Nv12Descriptors();planes[1]["shape"]={1,2,4,1};
  EXPECT_THROW(ainvr::PackBpuNv12(std::vector<uint8_t>(24),4,4,planes),std::invalid_argument);
  EXPECT_THROW(ainvr::PackBpuNv12(std::vector<uint8_t>(18),3,4,Nv12Descriptors()),std::invalid_argument);
}
TEST(BpuImageInput, RejectsOverlapsUndersizedAndUnboundedStorage) {
  auto d=FloatDescriptor();std::vector<float> values(18);
  for(auto strides:{std::vector<int>{96,32,8,4},std::vector<int>{96,16,16,4},
                   std::vector<int>{96,32,-1,4}}){d["byte_strides"]=strides;
    EXPECT_THROW(ainvr::PackBpuFloatNchw(values,d),std::invalid_argument);}
  d=FloatDescriptor();d["aligned_bytes"]=80;
  EXPECT_THROW(ainvr::PackBpuFloatNchw(values,d),std::invalid_argument);
  d["aligned_bytes"]=uint64_t(8192)*8192*16+1;
  EXPECT_THROW(ainvr::PackBpuFloatNchw(values,d),std::invalid_argument);
}
TEST(BpuImageInput, ProductionDoesNotFallBackToCpuImageProcessing) {
  ainvr::Nv12Frame input{128,128,0,std::vector<uint8_t>(128*128*3/2,128)};
  ainvr::ImageTransform transform;transform.width=96;transform.height=96;
  ainvr::ImagePreprocessor strict({false,false});
  EXPECT_THROW(strict.RunNv12(input,transform),std::runtime_error);
  EXPECT_THROW(strict.RunJpegNv12(input,transform),std::runtime_error);
  ainvr::ImagePreprocessor oracle({false,false,true});
  EXPECT_EQ(oracle.RunNv12(input,transform).backend,"cpu");
}
TEST(BpuImageInput, AuxiliaryRankThreeHonorsPaddedByteStrides) {
  auto d=Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,2,3},{32,16,4},32);
  std::vector<float> values{1,2,3,4,5,6};
  auto bytes=ainvr::PackBpuFloatTensor(values,d);
  ASSERT_EQ(bytes.size(),32u);
  for(int row=0;row<2;++row) {
    for(int col=0;col<3;++col) {
      float got;std::memcpy(&got,bytes.data()+row*16+col*4,4);
      EXPECT_FLOAT_EQ(got,values[row*3+col]);
    }
    for(int col=12;col<16;++col)EXPECT_EQ(bytes[row*16+col],0);
  }
}
TEST(BpuImageInput, DynamicAuxiliaryValuesFollowNamesDespiteDescriptorOrder) {
  auto image=FloatDescriptor();image["name"]="images";
  auto prompt=Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,2,3},{32,16,4},32);
  prompt["name"]="prompt_embeddings";
  auto inputs=json::array({prompt,image});std::vector<float> pixels(18,.25f);
  auto a=ainvr::PackBpuFloatInputs(pixels,inputs,"images",{{"prompt_embeddings",{1,2,3,4,5,6}}});
  auto b=ainvr::PackBpuFloatInputs(pixels,inputs,"images",{{"prompt_embeddings",{6,5,4,3,2,1}}});
  EXPECT_EQ(a[1],b[1]);EXPECT_NE(a[0],b[0]);
  EXPECT_EQ(ainvr::BpuFloatImageInputIndex(inputs,"images"),1u);
}
TEST(BpuImageInput, RejectsMissingUnknownAndDuplicatedInputNames) {
  auto image=FloatDescriptor();image["name"]="images";
  auto prompt=Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,2,3},{32,16,4},32);prompt["name"]="prompts";
  auto inputs=json::array({image,prompt});std::vector<float> pixels(18),values(6);
  EXPECT_THROW(ainvr::PackBpuFloatInputs(pixels,inputs,"images",{}),std::invalid_argument);
  EXPECT_THROW(ainvr::PackBpuFloatInputs(pixels,inputs,"images",{{"unknown",values}}),std::invalid_argument);
  EXPECT_THROW(ainvr::BpuFloatImageInputIndex(inputs,""),std::invalid_argument);
  EXPECT_THROW(ainvr::BpuFloatImageInputIndex(inputs,"missing"),std::invalid_argument);
  inputs[1]["name"]="images";
  EXPECT_THROW(ainvr::BpuFloatImageInputIndex(inputs,"images"),std::invalid_argument);
}
TEST(BpuImageInput, AuxiliaryRejectsBadShapesStorageAndNonFiniteValues) {
  auto d=Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,2,3},{32,16,4},32);std::vector<float> values(6);
  EXPECT_THROW(ainvr::PackBpuFloatTensor(std::vector<float>(5),d),std::invalid_argument);
  values[0]=std::numeric_limits<float>::quiet_NaN();
  EXPECT_THROW(ainvr::PackBpuFloatTensor(values,d),std::invalid_argument);values[0]=0;
  d["byte_strides"]={32,8,4};
  EXPECT_THROW(ainvr::PackBpuFloatTensor(values,d),std::invalid_argument);
  d=Descriptor(HB_DNN_TENSOR_TYPE_F32,{2,2,3},{32,16,4},64);
  EXPECT_THROW(ainvr::PackBpuFloatTensor(values,d),std::invalid_argument);
  d=Descriptor(HB_DNN_TENSOR_TYPE_F32,{1,2,3},{32,16,4},4*1024*1024+1);
  EXPECT_THROW(ainvr::PackBpuFloatTensor(values,d),std::invalid_argument);
}
TEST(BpuImageInput, LegacySingleImagePackingRemainsIdentical) {
  auto image=FloatDescriptor();std::vector<float> pixels(18,.125f);
  auto all=ainvr::PackBpuFloatInputs(pixels,json::array({image}),"",{});
  ASSERT_EQ(all.size(),1u);EXPECT_EQ(all[0],ainvr::PackBpuFloatNchw(pixels,image));
}

TEST(BpuImageInput, Int64TokenIdsKeepFullVocabularyAndPadding) {
  auto d=Descriptor(HB_DNN_TENSOR_TYPE_S64,{1,64},{544,8},544);
  std::vector<int64_t> tokens(64,1);tokens[0]=249999;tokens[1]=0;tokens[2]=32768;
  auto packed=ainvr::PackBpuTokenIds(tokens,d,250000);
  ASSERT_EQ(packed.size(),544u);
  for(size_t i=0;i<tokens.size();++i){int64_t value;std::memcpy(&value,packed.data()+i*8,8);EXPECT_EQ(value,tokens[i]);}
  for(size_t i=512;i<packed.size();++i)EXPECT_EQ(packed[i],0);
}
TEST(BpuImageInput, TokenContractsRejectWrongWidthVocabularyAndOverlaps) {
  auto d=Descriptor(HB_DNN_TENSOR_TYPE_S64,{1,64},{512,8},512);
  std::vector<int64_t> tokens(64,1);
  EXPECT_THROW(ainvr::PackBpuTokenIds(std::vector<int32_t>(64,1),d,250000),std::invalid_argument);
  tokens[0]=-1;EXPECT_THROW(ainvr::PackBpuTokenIds(tokens,d,250000),std::invalid_argument);
  tokens[0]=250000;EXPECT_THROW(ainvr::PackBpuTokenIds(tokens,d,250000),std::invalid_argument);
  tokens[0]=1;d["byte_strides"]={256,8};EXPECT_THROW(ainvr::PackBpuTokenIds(tokens,d,250000),std::invalid_argument);
  d=Descriptor(HB_DNN_TENSOR_TYPE_S64,{1,64},{512,4},512);EXPECT_THROW(ainvr::PackBpuTokenIds(tokens,d,250000),std::invalid_argument);
  d=Descriptor(HB_DNN_TENSOR_TYPE_S64,{1,64},{512,8},511);EXPECT_THROW(ainvr::PackBpuTokenIds(tokens,d,250000),std::invalid_argument);
}
TEST(BpuImageInput, ExistingClipInt32TokenLayoutRemainsExact) {
  auto d=Descriptor(HB_DNN_TENSOR_TYPE_S32,{1,77},{320,4},320);
  std::vector<int32_t> tokens(77,0);tokens[0]=49406;tokens[1]=49407;
  auto packed=ainvr::PackBpuTokenIds(tokens,d,49408);
  ASSERT_EQ(packed.size(),320u);EXPECT_EQ(std::memcmp(packed.data(),tokens.data(),77*4),0);
  for(size_t i=77*4;i<packed.size();++i)EXPECT_EQ(packed[i],0);
}

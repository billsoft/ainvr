// Copyright AINVR. Copies rows to SDK byte strides without CPU image conversion.
#include "bpu_image_input.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <set>
#include <cmath>
namespace ainvr {
namespace {
struct Layout {
  std::vector<int64_t> shape, strides;
  size_t bytes;
};
Layout Read(const nlohmann::json& d, int dtype, bool image=true) {
  if(d.at("dtype_id").get<int>()!=dtype || d.at("quantization").get<int>()!=NONE)
    throw std::invalid_argument("BPU image input dtype/quantization does not match explicit contract");
  Layout l{d.at("shape").get<std::vector<int64_t>>(),
    d.at("byte_strides").get<std::vector<int64_t>>(),d.at("aligned_bytes").get<size_t>()};
  if(l.shape.empty() || l.shape.size()>8 || (image && l.shape.size()!=4) ||
      l.strides.size()!=l.shape.size() || l.shape[0]!=1 || l.bytes==0)
    throw std::invalid_argument("BPU input must have valid fixed batch-one dimensions");
  for(size_t i=0;i<l.shape.size();++i) {
    if(l.shape[i]<=0 || l.strides[i]<=0)
      throw std::invalid_argument("Invalid BPU image dimension or byte stride");
    if(i+1<l.shape.size() && (l.strides[i+1]>std::numeric_limits<int64_t>::max()/l.shape[i+1] ||
      l.strides[i]<l.strides[i+1]*l.shape[i+1]))
      throw std::invalid_argument("Overlapping BPU image tensor rows/planes");
  }
  const size_t limit=image ? size_t(8192)*8192*16 : size_t(4)*1024*1024;
  if(uint64_t(l.strides[0])>l.bytes || l.bytes>limit)
    throw std::invalid_argument("BPU image storage is invalid or exceeds image limits");
  return l;
}
std::vector<unsigned char> CopyPlane(const unsigned char* source,int height,int row_bytes,
                                     const Layout& l) {
  if(l.strides[1]<row_bytes || size_t(l.strides[1])*height>l.bytes)
    throw std::invalid_argument("NV12 plane exceeds SDK aligned storage");
  std::vector<unsigned char> result(l.bytes,0);
  for(int row=0;row<height;++row)
    std::memcpy(result.data()+size_t(row)*l.strides[1],source+size_t(row)*row_bytes,row_bytes);
  return result;
}
}
std::vector<unsigned char> PackBpuFloatNchw(const std::vector<float>& values,
                                          const nlohmann::json& d) {
  auto l=Read(d,HB_DNN_TENSOR_TYPE_F32);
  if(l.shape[1]!=3 || l.shape[2]>8192 || l.shape[3]>8192 || l.strides[3]!=sizeof(float))
    throw std::invalid_argument("Expected explicit float32 NCHW RGB/BGR image contract");
  const size_t h=l.shape[2],w=l.shape[3];
  if(values.size()!=3*h*w)throw std::invalid_argument("Float32 image tensor element count mismatch");
  std::vector<unsigned char> result(l.bytes,0);
  for(size_t c=0;c<3;++c)for(size_t y=0;y<h;++y)
    std::memcpy(result.data()+c*l.strides[1]+y*l.strides[2],
      values.data()+(c*h+y)*w,w*sizeof(float));
  return result;
}
std::vector<unsigned char> PackBpuFloatTensor(const std::vector<float>& values,
                                            const nlohmann::json& d) {
  auto l=Read(d,HB_DNN_TENSOR_TYPE_F32,false);
  size_t count=1;
  for(auto dimension:l.shape) {
    if(size_t(dimension)>size_t(1024)*1024/count)
      throw std::invalid_argument("Auxiliary BPU tensor exceeds bounded element count");
    count*=size_t(dimension);
  }
  if(l.strides.back()!=sizeof(float) || count!=values.size())
    throw std::invalid_argument("Auxiliary BPU float32 tensor layout/count mismatch");
  for(float value:values)if(!std::isfinite(value))
    throw std::invalid_argument("Auxiliary BPU tensor has a non-finite value");
  const size_t width=l.shape.back(),rows=count/width;
  std::vector<unsigned char> result(l.bytes,0);
  for(size_t row=0;row<rows;++row) {
    size_t remaining=row,offset=0;
    for(size_t axis=l.shape.size()-1;axis>0;--axis) {
      size_t dimension=l.shape[axis-1];
      offset+=(remaining%dimension)*size_t(l.strides[axis-1]);
      remaining/=dimension;
    }
    if(offset>l.bytes || width*sizeof(float)>l.bytes-offset)
      throw std::invalid_argument("Auxiliary BPU tensor row exceeds SDK storage");
    std::memcpy(result.data()+offset,values.data()+row*width,width*sizeof(float));
  }
  return result;
}
size_t BpuFloatImageInputIndex(const nlohmann::json& inputs,const std::string& name) {
  if(!inputs.is_array() || inputs.empty() || inputs.size()>16)
    throw std::invalid_argument("Invalid BPU input descriptor count");
  if(name.empty()) {
    if(inputs.size()!=1)throw std::invalid_argument("Multi-input BPU image model requires an explicit image input name");
    return 0;
  }
  std::set<std::string> names;size_t index=inputs.size();
  for(size_t i=0;i<inputs.size();++i) {
    auto current=inputs[i].at("name").get<std::string>();
    if(current.empty() || !names.insert(current).second)
      throw std::invalid_argument("BPU input descriptor names must be unique and nonempty");
    if(current==name)index=i;
  }
  if(index==inputs.size())throw std::invalid_argument("BPU image input name does not exist");
  return index;
}
std::vector<std::vector<unsigned char>> PackBpuFloatInputs(
    const std::vector<float>& image,const nlohmann::json& inputs,
    const std::string& image_name,const std::map<std::string,std::vector<float>>& auxiliary) {
  const size_t index=BpuFloatImageInputIndex(inputs,image_name);
  if(auxiliary.size()+1!=inputs.size())
    throw std::invalid_argument("All auxiliary BPU inputs must be supplied exactly once");
  std::vector<std::vector<unsigned char>> result(inputs.size());
  result[index]=PackBpuFloatNchw(image,inputs[index]);
  for(size_t i=0;i<inputs.size();++i)if(i!=index) {
    auto found=auxiliary.find(inputs[i].at("name").get<std::string>());
    if(found==auxiliary.end())throw std::invalid_argument("Missing or unknown auxiliary BPU input name");
    result[i]=PackBpuFloatTensor(found->second,inputs[i]);
  }
  return result;
}
std::vector<std::vector<unsigned char>> PackBpuNv12(
    const std::vector<uint8_t>& pixels,int w,int h,const nlohmann::json& inputs) {
  if(w<2 || h<2 || w>8192 || h>8192 || w%2 || h%2 ||
      pixels.size()!=size_t(w)*h*3/2 || !inputs.is_array() || inputs.size()!=2)
    throw std::invalid_argument("Expected two-plane fixed NV12 BPU image input");
  auto y=Read(inputs[0],HB_DNN_TENSOR_TYPE_U8),uv=Read(inputs[1],HB_DNN_TENSOR_TYPE_U8);
  if(y.shape!=std::vector<int64_t>{1,h,w,1} || uv.shape!=std::vector<int64_t>{1,h/2,w/2,2} ||
     y.strides[3]!=1 || y.strides[2]!=1 || uv.strides[3]!=1 || uv.strides[2]!=2)
    throw std::invalid_argument("BPU NV12 input order/dimensions/channels do not match Y then UV contract");
  return {CopyPlane(pixels.data(),h,w,y),CopyPlane(pixels.data()+size_t(w)*h,h/2,w,uv)};
}
}

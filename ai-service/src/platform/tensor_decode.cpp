#include "tensor_decode.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
namespace ainvr {
namespace {
template<class T> double Read(const unsigned char* p){T value;std::memcpy(&value,p,sizeof(T));return double(value);}
double Half(const unsigned char* p){
  uint16_t h;std::memcpy(&h,p,2);int exp=(h>>10)&31;int frac=h&1023;
  double value=exp==0?std::ldexp(double(frac),-24):exp==31?(frac?std::numeric_limits<double>::quiet_NaN():std::numeric_limits<double>::infinity()):std::ldexp(1.+frac/1024.,exp-15);
  return (h&32768)?-value:value;
}
}
std::vector<float> DecodeTensor(const std::vector<unsigned char>& bytes,const nlohmann::json& d){
  auto shape=d.at("shape").get<std::vector<int64_t>>();auto strides=d.at("byte_strides").get<std::vector<int64_t>>();
  int type=d.at("dtype_id");size_t element=0;
  switch(type){
    case HB_DNN_TENSOR_TYPE_S8:case HB_DNN_TENSOR_TYPE_U8:case HB_DNN_TENSOR_TYPE_BOOL8:element=1;break;
    case HB_DNN_TENSOR_TYPE_S16:case HB_DNN_TENSOR_TYPE_U16:case HB_DNN_TENSOR_TYPE_F16:element=2;break;
    case HB_DNN_TENSOR_TYPE_S32:case HB_DNN_TENSOR_TYPE_U32:case HB_DNN_TENSOR_TYPE_F32:element=4;break;
    case HB_DNN_TENSOR_TYPE_S64:case HB_DNN_TENSOR_TYPE_U64:case HB_DNN_TENSOR_TYPE_F64:element=8;break;
    default:throw std::invalid_argument("Unsupported packed tensor dtype");
  }
  if(shape.empty()||shape.size()!=strides.size()||bytes.size()!=d.at("aligned_bytes").get<size_t>())throw std::invalid_argument("Invalid tensor descriptor/storage");
  size_t count=1,last=0;
  for(size_t k=0;k<shape.size();++k){
    if(shape[k]<=0||strides[k]<0||size_t(shape[k])>std::numeric_limits<size_t>::max()/count)throw std::invalid_argument("Invalid tensor dimension");
    count*=shape[k];size_t n=shape[k]-1;
    if(n&&size_t(strides[k])>(std::numeric_limits<size_t>::max()-last)/n)throw std::invalid_argument("Tensor offset overflow");
    last+=n*strides[k];
  }
  if(last>bytes.size()||element>bytes.size()-last||count>bytes.size()/element)throw std::invalid_argument("Tensor exceeds storage");
  int quant=d.at("quantization");auto scales=d.at("scales").get<std::vector<double>>();auto zeros=d.at("zero_points").get<std::vector<double>>();int axis=d.at("quantize_axis");
  if(axis<0)axis+=shape.size();
  if(quant!=NONE&&quant!=SCALE)throw std::invalid_argument("Unsupported quantization");
  if(quant==SCALE){
    if(scales.empty()||axis<0||axis>=int(shape.size()))throw std::invalid_argument("Invalid quantization metadata");
    if((scales.size()!=1&&scales.size()!=size_t(shape[axis]))||(!zeros.empty()&&zeros.size()!=1&&zeros.size()!=size_t(shape[axis])))throw std::invalid_argument("Invalid quantization lengths");
    for(double s:scales)if(!std::isfinite(s)||s<=0)throw std::invalid_argument("Invalid scale");
  }
  std::vector<float> output(count);
  for(size_t i=0;i<count;++i){
    size_t n=i,offset=0,q=0;
    for(int k=int(shape.size())-1;k>=0;--k){size_t c=n%shape[k];n/=shape[k];offset+=c*strides[k];if(k==axis)q=c;}
    const auto* p=bytes.data()+offset;double value=0;
    switch(type){
      case HB_DNN_TENSOR_TYPE_S8:value=Read<int8_t>(p);break;
      case HB_DNN_TENSOR_TYPE_U8:case HB_DNN_TENSOR_TYPE_BOOL8:value=Read<uint8_t>(p);break;
      case HB_DNN_TENSOR_TYPE_S16:value=Read<int16_t>(p);break;
      case HB_DNN_TENSOR_TYPE_U16:value=Read<uint16_t>(p);break;
      case HB_DNN_TENSOR_TYPE_F16:value=Half(p);break;
      case HB_DNN_TENSOR_TYPE_S32:value=Read<int32_t>(p);break;
      case HB_DNN_TENSOR_TYPE_U32:value=Read<uint32_t>(p);break;
      case HB_DNN_TENSOR_TYPE_F32:value=Read<float>(p);break;
      case HB_DNN_TENSOR_TYPE_S64:value=Read<int64_t>(p);break;
      case HB_DNN_TENSOR_TYPE_U64:value=Read<uint64_t>(p);break;
      case HB_DNN_TENSOR_TYPE_F64:value=Read<double>(p);break;
    }
    if(quant==SCALE)value=(value-(zeros.empty()?0:zeros[zeros.size()==1?0:q]))*scales[scales.size()==1?0:q];
    output[i]=float(value);
  }
  return output;
}
}

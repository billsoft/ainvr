// Copyright AINVR.
#include "onnx_model.hpp"
#include <onnxruntime_c_api.h>
#include <cstring>
#include <cmath>
#include <limits>
#include <mutex>
#include <stdexcept>
namespace ainvr {
namespace {
const OrtApi& Api(){static const OrtApi* api=OrtGetApiBase()->GetApi(ORT_API_VERSION);if(!api)throw std::runtime_error("ONNX Runtime API version mismatch");return *api;}
void Check(OrtStatus* status){if(!status)return;std::string error=Api().GetErrorMessage(status);Api().ReleaseStatus(status);throw std::runtime_error("ONNX CPU: "+error);}
std::vector<int64_t> Shape(const OrtTensorTypeAndShapeInfo* info){
  ONNXTensorElementDataType type;Check(Api().GetTensorElementType(info,&type));
  if(type!=ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)throw std::invalid_argument("ONNX adapter requires float32 tensors");
  size_t rank=0;Check(Api().GetDimensionsCount(info,&rank));if(rank<1||rank>8)throw std::invalid_argument("Unsupported ONNX tensor rank");
  std::vector<int64_t> shape(rank);Check(Api().GetDimensions(info,shape.data(),rank));return shape;
}
size_t Count(const std::vector<int64_t>& shape){size_t count=1;for(auto d:shape){if(d<=0||uint64_t(d)>std::numeric_limits<size_t>::max()/count)throw std::invalid_argument("ONNX requires fixed positive tensor dimensions");count*=d;}return count;}
}
struct OnnxModel::State {
  const OrtApi* api=nullptr;
  OrtEnv* env=nullptr;OrtSessionOptions* options=nullptr;OrtSession* session=nullptr;OrtMemoryInfo* memory=nullptr;
  std::string input_name;std::vector<std::string> output_names;std::vector<int64_t> shape;size_t count=0;std::mutex mutex;
  ~State(){if(!api)return;if(session)api->ReleaseSession(session);if(options)api->ReleaseSessionOptions(options);if(memory)api->ReleaseMemoryInfo(memory);if(env)api->ReleaseEnv(env);}
};
OnnxModel::OnnxModel(const std::string& path,int threads):state_(std::make_unique<State>()){
  if(threads<1||threads>8)throw std::invalid_argument("ONNX CPU threads must be 1..8");
  auto& s=*state_;auto& api=Api();s.api=&api;Check(api.CreateEnv(ORT_LOGGING_LEVEL_WARNING,"AINVR",&s.env));
  Check(api.CreateSessionOptions(&s.options));Check(api.SetIntraOpNumThreads(s.options,threads));Check(api.SetInterOpNumThreads(s.options,1));
  Check(api.SetSessionExecutionMode(s.options,ORT_SEQUENTIAL));Check(api.CreateSession(s.env,path.c_str(),s.options,&s.session));
  size_t inputs=0,outputs=0;Check(api.SessionGetInputCount(s.session,&inputs));Check(api.SessionGetOutputCount(s.session,&outputs));
  if(inputs!=1||outputs<1||outputs>64)throw std::invalid_argument("ONNX adapter supports one input and 1..64 outputs");
  OrtAllocator* allocator=nullptr;Check(api.GetAllocatorWithDefaultOptions(&allocator));
  auto name=[&](bool input,size_t index){char* raw=nullptr;Check(input?api.SessionGetInputName(s.session,index,allocator,&raw):api.SessionGetOutputName(s.session,index,allocator,&raw));
    auto free=[allocator](char* p){allocator->Free(allocator,p);};std::unique_ptr<char,decltype(free)> value(raw,free);
    return std::string(raw);
  };
  s.input_name=name(true,0);for(size_t i=0;i<outputs;++i)s.output_names.push_back(name(false,i));
  OrtTypeInfo* raw=nullptr;Check(api.SessionGetInputTypeInfo(s.session,0,&raw));std::unique_ptr<OrtTypeInfo,decltype(api.ReleaseTypeInfo)> info(raw,api.ReleaseTypeInfo);
  const OrtTensorTypeAndShapeInfo* tensor=nullptr;Check(api.CastTypeInfoToTensorInfo(raw,&tensor));if(!tensor)throw std::invalid_argument("ONNX input is not a tensor");
  s.shape=Shape(tensor);s.count=Count(s.shape);Check(api.CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&s.memory));
}
OnnxModel::~OnnxModel()=default;
std::vector<int64_t> OnnxModel::InputShape()const{return state_->shape;}
std::vector<DenseTensor> OnnxModel::Run(const std::vector<float>& input){
  auto& s=*state_;std::lock_guard lock(s.mutex);if(input.size()!=s.count)throw std::invalid_argument("ONNX input element count mismatch");
  for(float value:input)if(!std::isfinite(value))throw std::invalid_argument("Non-finite ONNX input");
  auto& api=Api();OrtValue* raw=nullptr;
  Check(api.CreateTensorWithDataAsOrtValue(s.memory,const_cast<float*>(input.data()),input.size()*sizeof(float),s.shape.data(),s.shape.size(),ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&raw));
  std::unique_ptr<OrtValue,decltype(api.ReleaseValue)> tensor(raw,api.ReleaseValue);
  std::vector<const char*> names;for(const auto& name:s.output_names)names.push_back(name.c_str());
  struct Values {std::vector<OrtValue*> values;~Values(){for(auto* value:values)if(value)Api().ReleaseValue(value);}} outputs{std::vector<OrtValue*>(names.size())};
  const char* name=s.input_name.c_str();const OrtValue* value=tensor.get();
  Check(api.Run(s.session,nullptr,&name,&value,1,names.data(),names.size(),outputs.values.data()));
  std::vector<DenseTensor> result;
  for(size_t i=0;i<outputs.values.size();++i){
    OrtTensorTypeAndShapeInfo* raw_info=nullptr;Check(api.GetTensorTypeAndShape(outputs.values[i],&raw_info));
    std::unique_ptr<OrtTensorTypeAndShapeInfo,decltype(api.ReleaseTensorTypeAndShapeInfo)> info(raw_info,api.ReleaseTensorTypeAndShapeInfo);
    auto shape=Shape(raw_info);size_t count=Count(shape);void* data=nullptr;Check(api.GetTensorMutableData(outputs.values[i],&data));
    auto* floats=static_cast<float*>(data);result.push_back({s.output_names[i],shape,std::vector<float>(floats,floats+count)});
  }
  return result;
}
}

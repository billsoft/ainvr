// Copyright AINVR. No ONNX Runtime, CUDA, CPU resize, or CPU normalization.
#include "bpu_image_runner.hpp"
#include "bpu_image_input.hpp"
#include "tensor_decode.hpp"
#include <chrono>
#include <stdexcept>
namespace ainvr {
namespace {
using Clock=std::chrono::steady_clock;
double Ms(Clock::duration d){return std::chrono::duration<double,std::milli>(d).count();}
}
BpuImageRunner::BpuImageRunner(const std::string& path,BpuImageContract contract,
                               const std::string& image_input_name)
    :model_(path),contract_(contract),description_(model_.Describe()),
     image_input_name_(image_input_name),images_({true,true,false}) {
  if(contract_==BpuImageContract::FloatNchw)
    image_input_index_=BpuFloatImageInputIndex(description_["inputs"],image_input_name_);
  if(contract_==BpuImageContract::Nv12EmbeddedPreprocess && description_["inputs"].size()!=2)
    throw std::invalid_argument("NV12 image model requires exactly two inputs");
}
BpuImageResult BpuImageRunner::Run(const Nv12Frame& frame,const ImageTransform& transform,
                                  const std::map<std::string,std::vector<float>>& auxiliary) {
  return RunAsync(frame,transform,auxiliary).get();
}
std::future<BpuImageResult> BpuImageRunner::RunAsync(const Nv12Frame& frame,const ImageTransform& transform,
                                  const std::map<std::string,std::vector<float>>& auxiliary) {
  if(owner_!=std::this_thread::get_id())throw std::logic_error("BPU image runner thread mismatch");
  auto begin=Clock::now();PreprocessedImage prepared;
  std::vector<std::vector<unsigned char>> inputs;
  if(contract_==BpuImageContract::FloatNchw) {
    auto shape=description_["inputs"][image_input_index_]["shape"].get<std::vector<int>>();
    if(shape!=std::vector<int>{1,3,transform.height,transform.width})
      throw std::invalid_argument("GPU output dimensions differ from BPU NCHW input");
    prepared=images_.RunNv12(frame,transform);
    inputs=PackBpuFloatInputs(prepared.chw,description_["inputs"],image_input_name_,auxiliary);
  } else {
    if(!auxiliary.empty())throw std::invalid_argument("Embedded NV12 contract does not accept auxiliary tensors");
    if(transform.mean!=std::array<float,3>{0,0,0} || transform.divisor!=std::array<float,3>{1,1,1} || transform.bgr)
      throw std::invalid_argument("NV12 model owns embedded normalization/channel conversion; image adapter must not normalize twice");
    auto shape=description_["inputs"][0]["shape"].get<std::vector<int>>();
    if(shape!=std::vector<int>{1,transform.height,transform.width,1})
      throw std::invalid_argument("GPU output dimensions differ from BPU NV12 input");
    prepared=images_.RunJpegNv12(frame,transform);
    inputs=PackBpuNv12(prepared.jpeg_nv12,transform.width,transform.height,description_["inputs"]);
  }
  if(prepared.backend.find("cpu")!=std::string::npos)
    throw std::logic_error("CPU image processing must not feed production BPU inference");
  const double preprocess_ms=Ms(Clock::now()-begin);
  return std::async(std::launch::async,[this,inputs=std::move(inputs),backend=std::move(prepared.backend),preprocess_ms]() {
    std::lock_guard lock(inference_mutex_);
    const auto start=Clock::now();auto bytes=model_.Run(inputs);auto inferred=Clock::now();
    BpuImageResult result;result.image_backend=backend;
    for(size_t i=0;i<bytes.size();++i)result.outputs.push_back(DecodeTensor(bytes[i],description_["outputs"][i]));
    result.preprocess_ms=preprocess_ms;result.inference_ms=Ms(inferred-start);
    result.output_decode_ms=Ms(Clock::now()-inferred);return result;
  });
}
}

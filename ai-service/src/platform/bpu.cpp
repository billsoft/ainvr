#include "bpu.hpp"
#include <cstring>
#include <stdexcept>
#include <limits>
#include <atomic>

namespace ainvr {
namespace {
std::atomic<bool> runtime_healthy{true};
std::atomic<uint64_t> quarantined_bytes{0};
void Check(int rc, const char* operation) {
  if (rc != 0) throw std::runtime_error(std::string(operation) + ": " + std::to_string(rc));
}
}
bool BpuRuntimeHealthy() noexcept { return runtime_healthy.load(); }
uint64_t BpuQuarantinedBytes() noexcept { return quarantined_bytes.load(); }
struct BpuModel::Quarantine {
  hbDNNPackedHandle_t packed=nullptr;
  hbUCPTaskHandle_t task=nullptr;
  std::vector<hbDNNTensor> inputs,outputs;
};
BpuModel::BpuModel(const std::string& path, const std::string& name) {
  if(!BpuRuntimeHealthy())throw std::runtime_error("BPU runtime fault; service restart required");
  // Reserve custody before submitting work; timeout cleanup must not allocate.
  quarantine_=std::make_unique<Quarantine>();
  try {
    const char* file = path.c_str();
    Check(hbDNNInitializeFromFiles(&packed_, &file, 1), "load HBM");
    const char** names = nullptr; int32_t count = 0;
    Check(hbDNNGetModelNameList(&names, &count, packed_), "model names");
    if (name.empty() && count != 1) throw std::runtime_error("Specify model name for multi-model HBM");
    name_ = name.empty() ? names[0] : name;
    Check(hbDNNGetModelHandle(&model_, packed_, name_.c_str()), "model handle");
    for (bool input : {true, false}) {
      int32_t size = 0;
      Check(input ? hbDNNGetInputCount(&size, model_) : hbDNNGetOutputCount(&size, model_), "tensor count");
      auto& tensors = input ? inputs_ : outputs_;
      auto& tensor_names = input ? input_names_ : output_names_;
      tensors.resize(size);
      for (int i = 0; i < size; ++i) {
        auto& t = tensors[i]; const char* tensor_name = nullptr;
        Check(input ? hbDNNGetInputTensorProperties(&t.properties, model_, i) : hbDNNGetOutputTensorProperties(&t.properties, model_, i), "tensor properties");
        Check(input ? hbDNNGetInputName(&tensor_name, model_, i) : hbDNNGetOutputName(&tensor_name, model_, i), "tensor name");
        tensor_names.emplace_back(tensor_name);
        if (input) {
          auto& p=t.properties;int rank=p.validShape.numDimensions;
          if(rank<1||rank>HB_DNN_TENSOR_MAX_DIMENSIONS)throw std::runtime_error("Invalid tensor rank");
          // S100 SDK permits dynamic row strides and alignedByteSize=0 for
          // image inputs. Resolve byte strides at the documented 32B boundary.
          for(int k=rank-1;k>=0;--k){
            if(p.validShape.dimensionSize[k]<=0)throw std::runtime_error("Dynamic shape requires explicit model specialization");
            if(p.stride[k]==-1){
              if(k==rank-1)throw std::runtime_error("Unknown innermost byte stride");
              int64_t dim=p.validShape.dimensionSize[k+1];
              if(p.stride[k+1]>(std::numeric_limits<int64_t>::max()-31)/dim)throw std::runtime_error("Tensor size overflow");
              p.stride[k]=(p.stride[k+1]*dim+31)&~int64_t(31);
            }
            if(p.stride[k]<=0)throw std::runtime_error("Invalid input stride");
          }
          if(p.stride[0]>std::numeric_limits<int64_t>::max()/p.validShape.dimensionSize[0])throw std::runtime_error("Tensor size overflow");
          p.alignedByteSize=std::max(p.alignedByteSize,p.stride[0]*p.validShape.dimensionSize[0]);
        }
        if (t.properties.alignedByteSize <= 0) throw std::runtime_error("Invalid aligned tensor size");
        Check(hbUCPMallocCached(&t.sysMem, t.properties.alignedByteSize, 0), "allocate tensor");
      }
    }
  } catch (...) { Clear(); throw; }
}
BpuModel::~BpuModel() { Clear(); }
void BpuModel::Clear() noexcept {
  if(inflight_){
    quarantine_->packed=packed_;quarantine_->task=inflight_;
    quarantine_->inputs=std::move(inputs_);quarantine_->outputs=std::move(outputs_);
    for(const auto* tensors:{&quarantine_->inputs,&quarantine_->outputs})
      for(const auto& t:*tensors)quarantined_bytes.fetch_add(t.properties.alignedByteSize);
    // Preserve task, descriptor arrays, DMA buffers and HBM until process exit.
    // Completion is unknown; freeing them here would allow DMA into freed RAM.
    // The global fault prevents new work and stops watchdog notifications.
    (void)quarantine_.release();packed_=nullptr;model_=nullptr;inflight_=nullptr;
    return;
  }
  for (auto* tensors : {&inputs_, &outputs_})
    for (auto& t : *tensors) if (t.sysMem.virAddr) hbUCPFree(&t.sysMem);
  if (packed_) hbDNNRelease(packed_);
  packed_ = nullptr;
}
nlohmann::json BpuModel::Describe() const {
  nlohmann::json j = {{"model", name_}, {"provider", "bpu"}, {"format", "hbm"},
      {"soc", hbUCPGetSocName()}, {"dnn_version", hbDNNGetVersion()}, {"ucp_version", hbUCPGetVersion()}};
  for (bool input : {true, false}) {
    const auto& tensors = input ? inputs_ : outputs_;
    const auto& names = input ? input_names_ : output_names_;
    auto list = nlohmann::json::array();
    for (size_t i = 0; i < tensors.size(); ++i) {
      const auto& p = tensors[i].properties;
      auto shape = nlohmann::json::array(), stride = nlohmann::json::array();
      for (int k = 0; k < p.validShape.numDimensions; ++k) {
        shape.push_back(p.validShape.dimensionSize[k]); stride.push_back(p.stride[k]);
      }
      auto scales = nlohmann::json::array(), zeros = nlohmann::json::array();
      for (int k = 0; k < p.scale.scaleLen; ++k) scales.push_back(p.scale.scaleData[k]);
      for (int k = 0; k < p.scale.zeroPointLen; ++k) zeros.push_back(p.scale.zeroPointData[k]);
      list.push_back({{"name", names[i]}, {"shape", shape}, {"dtype_id", p.tensorType},
          {"byte_strides", stride}, {"aligned_bytes", p.alignedByteSize},
          {"quantization", p.quantiType}, {"quantize_axis", p.quantizeAxis},
          {"scales", scales}, {"zero_points", zeros}});
    }
    j[input ? "inputs" : "outputs"] = list;
  }
  return j;
}
std::vector<std::vector<unsigned char>> BpuModel::Run(const std::vector<std::vector<unsigned char>>& data) {
  std::lock_guard<std::mutex> lock(mutex_);
  if(!BpuRuntimeHealthy())throw std::runtime_error("BPU runtime fault; service restart required");
  if (data.size() != inputs_.size()) throw std::invalid_argument("HBM input count mismatch");
  for (size_t i = 0; i < data.size(); ++i) {
    auto& t = inputs_[i];
    if (data[i].size() != static_cast<size_t>(t.properties.alignedByteSize))
      throw std::invalid_argument("HBM aligned input size mismatch: " + input_names_[i]);
    std::memcpy(t.sysMem.virAddr, data[i].data(), data[i].size());
    Check(hbUCPMemFlush(&t.sysMem, HB_SYS_MEM_CACHE_CLEAN), "clean input cache");
  }
  hbUCPTaskHandle_t task = nullptr;
  // Some SDK failures still return a task. Until release succeeds, that task
  // may retain references to every tensor and the packed model.
  const auto release_failed_task = [&] {
    if (task && hbUCPReleaseTask(task) != 0) {
      inflight_ = task;
      runtime_healthy.store(false);
    }
  };
  int rc = hbDNNInferV2(&task, outputs_.data(), inputs_.data(), model_);
  if (rc != 0) {
    release_failed_task();
    Check(rc, "create inference task");
  }
  hbUCPSchedParam sched; HB_UCP_INITIALIZE_SCHED_PARAM(&sched);
  sched.backend = HB_UCP_BPU_CORE_ANY;
  rc = hbUCPSubmitTask(task, &sched);
  if (rc != 0) {
    release_failed_task();
    Check(rc, "submit inference");
  }
  inflight_=task;
  // The SDK timeout is in milliseconds. Only success proves completion.
  rc = hbUCPWaitTaskDone(task, 10000);
  if(rc!=0){
    runtime_healthy.store(false);
    throw std::runtime_error("BPU wait failed; hardware resources retained until service restart: "+std::to_string(rc));
  }
  rc=hbUCPReleaseTask(task);
  if(rc!=0)runtime_healthy.store(false);
  Check(rc,"release completed inference");
  inflight_=nullptr;
  std::vector<std::vector<unsigned char>> result;
  for (auto& t : outputs_) {
    Check(hbUCPMemFlush(&t.sysMem, HB_SYS_MEM_CACHE_INVALIDATE), "invalidate output cache");
    auto* p = static_cast<unsigned char*>(t.sysMem.virAddr);
    result.emplace_back(p, p + t.properties.alignedByteSize);
  }
  return result;
}
}

#include "platform/bpu_pack.hpp"
#include "platform/bpu.hpp"
#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace ainvr {
namespace {
void Check(int rc, const char* operation) {
  if (rc != 0) throw std::runtime_error(std::string(operation) + ": " + std::to_string(rc));
}
}  // namespace

int64_t BpuTensorInfo::Elements() const {
  int64_t n = 1;
  for (auto d : shape) n *= d;
  return n;
}

std::shared_ptr<BpuPack> BpuPack::Load(const std::string& path) {
  if (!BpuRuntimeHealthy()) throw std::runtime_error("BPU runtime fault; service restart required");
  std::shared_ptr<BpuPack> pack(new BpuPack());
  const char* file = path.c_str();
  Check(hbDNNInitializeFromFiles(&pack->packed_, &file, 1), "load HBM");
  const char** names = nullptr;
  int32_t count = 0;
  Check(hbDNNGetModelNameList(&names, &count, pack->packed_), "model names");
  for (int32_t i = 0; i < count; ++i) pack->names_.emplace_back(names[i]);
  return pack;
}

BpuPack::~BpuPack() {
  if (packed_ && !leaked_.load()) hbDNNRelease(packed_);
}

BpuProgram::BpuProgram(std::shared_ptr<BpuPack> pack, const std::string& model_name)
    : pack_(std::move(pack)), name_(model_name) {
  if (!BpuRuntimeHealthy()) throw std::runtime_error("BPU runtime fault; service restart required");
  try {
    Check(hbDNNGetModelHandle(&model_, pack_->packed_, name_.c_str()), "model handle");
    for (bool input : {true, false}) {
      int32_t size = 0;
      Check(input ? hbDNNGetInputCount(&size, model_) : hbDNNGetOutputCount(&size, model_), "tensor count");
      auto& tensors = input ? inputs_ : outputs_;
      auto& infos = input ? input_info_ : output_info_;
      tensors.assign(size, hbDNNTensor{});
      infos.resize(size);
      for (int i = 0; i < size; ++i) {
        auto& t = tensors[i];
        const char* tensor_name = nullptr;
        Check(input ? hbDNNGetInputTensorProperties(&t.properties, model_, i)
                    : hbDNNGetOutputTensorProperties(&t.properties, model_, i), "tensor properties");
        Check(input ? hbDNNGetInputName(&tensor_name, model_, i) : hbDNNGetOutputName(&tensor_name, model_, i), "tensor name");
        auto& p = t.properties;
        const int rank = p.validShape.numDimensions;
        if (rank < 1 || rank > HB_DNN_TENSOR_MAX_DIMENSIONS) throw std::runtime_error("Invalid tensor rank");
        if (p.tensorType != HB_DNN_TENSOR_TYPE_F32 || p.quantiType != NONE) throw std::runtime_error("embedding tensor must be float32");
        for (int k = rank - 1; k >= 0; --k) {
          if (p.validShape.dimensionSize[k] <= 0) throw std::runtime_error("Dynamic shape unsupported");
          if (input && p.stride[k] == -1) {
            if (k == rank - 1) throw std::runtime_error("Unknown innermost byte stride");
            p.stride[k] = (p.stride[k + 1] * p.validShape.dimensionSize[k + 1] + 31) & ~int64_t(31);
          }
          if (p.stride[k] <= 0) throw std::runtime_error("Invalid tensor stride");
        }
        if (p.stride[rank - 1] != 4) throw std::runtime_error("unexpected innermost stride");
        if (input) p.alignedByteSize = std::max<int64_t>(p.alignedByteSize, p.stride[0] * p.validShape.dimensionSize[0]);
        if (p.alignedByteSize <= 0) throw std::runtime_error("Invalid aligned tensor size");
        auto& info = infos[i];
        info.name = tensor_name;
        info.dtype = p.tensorType;
        info.aligned_bytes = p.alignedByteSize;
        for (int k = 0; k < rank; ++k) {
          info.shape.push_back(p.validShape.dimensionSize[k]);
          info.strides.push_back(p.stride[k]);
        }
        Check(hbUCPMallocCached(&t.sysMem, p.alignedByteSize, 0), "allocate tensor");
        std::memset(t.sysMem.virAddr, 0, size_t(p.alignedByteSize));
      }
    }
  } catch (...) { Release(); throw; }
}

BpuProgram::~BpuProgram() { Release(); }

void BpuProgram::Release() noexcept {
  if (inflight_) { pack_->Quarantine(); return; }  // DMA buffers stay until process exit
  if (pack_ && pack_->Leaked()) return;
  for (auto* tensors : {&inputs_, &outputs_})
    for (auto& t : *tensors) if (t.sysMem.virAddr) hbUCPFree(&t.sysMem);
  inputs_.clear();
  outputs_.clear();
}

namespace {
// Copy between a tightly packed float array and a strided tensor (innermost stride 4).
void Strided(const BpuTensorInfo& info, unsigned char* base, float* packed, bool to_tensor) {
  const size_t rank = info.shape.size();
  const size_t row = size_t(info.shape[rank - 1]) * sizeof(float);
  int64_t rows = 1;
  for (size_t k = 0; k + 1 < rank; ++k) rows *= info.shape[k];
  std::vector<int64_t> index(rank > 1 ? rank - 1 : 0, 0);
  for (int64_t r = 0; r < rows; ++r) {
    int64_t offset = 0;
    for (size_t k = 0; k + 1 < rank; ++k) offset += index[k] * info.strides[k];
    unsigned char* tensor_row = base + offset;
    float* packed_row = packed + size_t(r) * size_t(info.shape[rank - 1]);
    if (to_tensor) std::memcpy(tensor_row, packed_row, row);
    else std::memcpy(packed_row, tensor_row, row);
    for (size_t k = rank - 1; k-- > 0;) {
      if (++index[k] < info.shape[k]) break;
      index[k] = 0;
    }
  }
}
}  // namespace

void BpuProgram::SetInput(size_t index, const float* packed) {
  if (index >= inputs_.size()) throw std::invalid_argument("input index");
  auto& t = inputs_[index];
  Strided(input_info_[index], static_cast<unsigned char*>(t.sysMem.virAddr), const_cast<float*>(packed), true);
  Check(hbUCPMemFlush(&t.sysMem, HB_SYS_MEM_CACHE_CLEAN), "clean input cache");
}

void BpuProgram::GetOutput(size_t index, float* packed) const {
  if (index >= outputs_.size()) throw std::invalid_argument("output index");
  Strided(output_info_[index], static_cast<unsigned char*>(const_cast<hbDNNTensor&>(outputs_[index]).sysMem.virAddr), packed, false);
}

namespace {
bool Packed(const BpuTensorInfo& info) {
  int64_t stride = 4;
  for (size_t k = info.shape.size(); k-- > 0;) {
    if (info.strides[k] != stride) return false;
    stride *= info.shape[k];
  }
  return true;
}
}  // namespace
bool BpuProgram::InputPacked(size_t index) const { return index < input_info_.size() && Packed(input_info_[index]); }
bool BpuProgram::OutputPacked(size_t index) const { return index < output_info_.size() && Packed(output_info_[index]); }
float* BpuProgram::InputData(size_t index) { return static_cast<float*>(inputs_.at(index).sysMem.virAddr); }
void BpuProgram::FlushInput(size_t index) { Check(hbUCPMemFlush(&inputs_.at(index).sysMem, HB_SYS_MEM_CACHE_CLEAN), "clean input cache"); }
const float* BpuProgram::OutputData(size_t index) const { return static_cast<const float*>(outputs_.at(index).sysMem.virAddr); }

void BpuProgram::Run() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!BpuRuntimeHealthy()) throw std::runtime_error("BPU runtime fault; service restart required");
  hbUCPTaskHandle_t task = nullptr;
  const auto release_failed_task = [&] {
    if (task && hbUCPReleaseTask(task) != 0) { inflight_ = task; BpuMarkRuntimeFault(); }
  };
  int rc = hbDNNInferV2(&task, outputs_.data(), inputs_.data(), model_);
  if (rc != 0) { release_failed_task(); Check(rc, "create inference task"); }
  hbUCPSchedParam sched;
  HB_UCP_INITIALIZE_SCHED_PARAM(&sched);
  sched.backend = HB_UCP_BPU_CORE_ANY;
  rc = hbUCPSubmitTask(task, &sched);
  if (rc != 0) { release_failed_task(); Check(rc, "submit inference"); }
  inflight_ = task;
  rc = hbUCPWaitTaskDone(task, 20000);
  if (rc != 0) {
    BpuMarkRuntimeFault();
    pack_->Quarantine();
    throw std::runtime_error("BPU wait failed; hardware resources retained until service restart: " + std::to_string(rc));
  }
  rc = hbUCPReleaseTask(task);
  if (rc != 0) BpuMarkRuntimeFault();
  Check(rc, "release completed inference");
  inflight_ = nullptr;
  for (auto& t : outputs_) Check(hbUCPMemFlush(&t.sysMem, HB_SYS_MEM_CACHE_INVALIDATE), "invalidate output cache");
}

}  // namespace ainvr

#include "bpu_program.hpp"
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <chrono>

namespace ainvr::llm {
thread_local std::function<void(double)> task_time_observer;
namespace {
void Check(int rc, const char* operation) {
  if(rc) throw std::runtime_error(std::string(operation)+": "+std::to_string(rc));
}
size_t Offset(size_t flat, const hbDNNTensorProperties& p) {
  size_t off=0;
  for(int d=p.validShape.numDimensions-1;d>=0;--d) {
    off+=(flat%p.validShape.dimensionSize[d])*p.stride[d];
    flat/=p.validShape.dimensionSize[d];
  }
  return off;
}
nlohmann::json Shape(const hbDNNTensorProperties& p) {
  auto a=nlohmann::json::array();
  for(int d=0;d<p.validShape.numDimensions;++d) a.push_back(p.validShape.dimensionSize[d]);
  return a;
}
Tensor MakeTensor(hbDNNHandle_t model, bool input, int index, BufferPool& pool) {
  Tensor t; auto& p=t.descriptor.properties; const char* name=nullptr;
  Check(input?hbDNNGetInputTensorProperties(&p,model,index):hbDNNGetOutputTensorProperties(&p,model,index),"tensor properties");
  Check(input?hbDNNGetInputName(&name,model,index):hbDNNGetOutputName(&name,model,index),"tensor name");
  t.name=name;
  if(p.tensorType!=HB_DNN_TENSOR_TYPE_F32) throw std::runtime_error("review package requires float32 ports");
  int n=p.validShape.numDimensions;
  if(n<1||n>HB_DNN_TENSOR_MAX_DIMENSIONS) throw std::runtime_error("invalid tensor rank");
  for(int d=n-1;d>=0;--d) {
    if(p.validShape.dimensionSize[d]<=0) throw std::runtime_error("dynamic shape unsupported");
    if(p.stride[d]==-1 && d<n-1) p.stride[d]=(p.stride[d+1]*p.validShape.dimensionSize[d+1]+31)&~int64_t(31);
    if(p.stride[d]<=0) throw std::runtime_error("invalid tensor stride");
  }
  p.alignedByteSize=std::max(p.alignedByteSize,p.stride[0]*p.validShape.dimensionSize[0]);
  // Every call is serialized by the engine; input ports may safely share storage
  // across packages/profiles. Outputs remain separate until copied to host.
  std::string key;
  if(input) {
    key=t.name+":"+Shape(p).dump()+":"+std::to_string(p.alignedByteSize);
    for(int d=0;d<n;++d) key+=":"+std::to_string(p.stride[d]);
  }
  if(input && pool.count(key)) t.buffer=pool.at(key);
  else { t.buffer=std::make_shared<DmaBuffer>(p.alignedByteSize); if(input) pool.emplace(key,t.buffer); }
  t.descriptor.sysMem=t.buffer->memory;
  return t;
}
}
size_t Tensor::elements() const {
  size_t count=1; const auto& p=descriptor.properties;
  for(int d=0;d<p.validShape.numDimensions;++d) count*=p.validShape.dimensionSize[d];
  return count;
}
void Tensor::Write(const float* data,size_t count) {
  if(count!=elements()) throw std::invalid_argument("input shape mismatch: "+name);
  auto& p=descriptor.properties; auto* dst=static_cast<char*>(buffer->memory.virAddr);
  if(size_t(p.alignedByteSize)==count*4) std::memcpy(dst,data,count*4);
  else { std::memset(dst,0,p.alignedByteSize); for(size_t i=0;i<count;++i) std::memcpy(dst+Offset(i,p),data+i,4); }
  Check(hbUCPMemFlush(&buffer->memory,HB_SYS_MEM_CACHE_CLEAN),"flush input");
}
std::vector<float> Tensor::Read() const {
  Check(hbUCPMemFlush(&buffer->memory,HB_SYS_MEM_CACHE_INVALIDATE),"invalidate output");
  std::vector<float> out(elements()); const auto& p=descriptor.properties;
  auto* src=static_cast<const char*>(buffer->memory.virAddr);
  if(size_t(p.alignedByteSize)==out.size()*4) std::memcpy(out.data(),src,out.size()*4);
  else for(size_t i=0;i<out.size();++i) std::memcpy(out.data()+i,src+Offset(i,p),4);
  return out;
}
BpuProgram::BpuProgram(const std::string& file,const nlohmann::json& profiles,
                       const std::string& root,BufferPool& pool) {
  const char* path=file.c_str(); Check(hbDNNInitializeFromFiles(&packed_,&path,1),"load HBM");
  try {
    const char** names=nullptr; int32_t count=0;
    Check(hbDNNGetModelNameList(&names,&count,packed_),"model names");
    for(auto it=profiles.begin();it!=profiles.end();++it) {
      std::ifstream f(root+"/"+it.value().get<std::string>()); nlohmann::json ports; f>>ports;
      int matches=0; Profile selected;
      for(int m=0;m<count;++m) {
        hbDNNHandle_t handle{}; Check(hbDNNGetModelHandle(&handle,packed_,names[m]),"model handle");
        int32_t ni=0,no=0; Check(hbDNNGetInputCount(&ni,handle),"input count"); Check(hbDNNGetOutputCount(&no,handle),"output count");
        if(ni!=int(ports["inputs"].size())||no!=int(ports["outputs"].size())) continue;
        bool same=true;
        for(bool input:{true,false}) for(int i=0;i<(input?ni:no);++i) {
          hbDNNTensorProperties p{}; const char* name=nullptr;
          Check(input?hbDNNGetInputTensorProperties(&p,handle,i):hbDNNGetOutputTensorProperties(&p,handle,i),"properties");
          Check(input?hbDNNGetInputName(&name,handle,i):hbDNNGetOutputName(&name,handle,i),"name");
          auto expected=ports[input?"inputs":"outputs"][i];
          if(expected["name"]!=name||expected["shape"]!=Shape(p)) same=false;
        }
        if(same) { ++matches; selected.model=handle; }
      }
      if(matches!=1) throw std::runtime_error("ambiguous or missing HBM profile: "+it.key());
      for(int i=0;i<int(ports["inputs"].size());++i) selected.inputs.push_back(MakeTensor(selected.model,true,i,pool));
      for(int i=0;i<int(ports["outputs"].size());++i) selected.outputs.push_back(MakeTensor(selected.model,false,i,pool));
      profiles_.emplace(it.key(),std::move(selected));
    }
  } catch(...) { profiles_.clear(); hbDNNRelease(packed_); packed_=nullptr; throw; }
}
BpuProgram::~BpuProgram() { profiles_.clear(); if(packed_) hbDNNRelease(packed_); }
std::vector<std::vector<float>> BpuProgram::Run(const std::string& profile,const std::vector<std::vector<float>>& values,
                                              const std::function<void()>& before_submit) {
  auto& p=profiles_.at(profile);
  if(values.size()!=p.inputs.size()) throw std::invalid_argument("port count mismatch");
  std::vector<hbDNNTensor> ins,outs;
  for(size_t i=0;i<values.size();++i) { p.inputs[i].Write(values[i].data(),values[i].size()); ins.push_back(p.inputs[i].descriptor); }
  for(auto& t:p.outputs) outs.push_back(t.descriptor);
  if(before_submit) before_submit();
  hbUCPTaskHandle_t task{}; Check(hbDNNInferV2(&task,outs.data(),ins.data(),p.model),"create task");
  hbUCPSchedParam sched; HB_UCP_INITIALIZE_SCHED_PARAM(&sched); sched.backend=HB_UCP_BPU_CORE_ANY;
  auto submitted=std::chrono::steady_clock::now();
  int rc=hbUCPSubmitTask(task,&sched);
  if(rc) { hbUCPReleaseTask(task); Check(rc,"submit task"); }
  rc=hbUCPWaitTaskDone(task,10000);
  if(rc) {
    // Do not unwind: SDK may retain descriptor pointers and DMA buffers.
    // Process termination lets the kernel reclaim them; systemd restarts cleanly.
    std::cerr<<"BPU wait failed; terminating without freeing in-flight resources: "<<rc<<std::endl;
    std::_Exit(70);
  }
  Check(hbUCPReleaseTask(task),"release task");
  if(task_time_observer)task_time_observer(std::chrono::duration<double>(std::chrono::steady_clock::now()-submitted).count());
  std::vector<std::vector<float>> result;
  for(const auto& t:p.outputs) result.push_back(t.Read());
  return result;
}
} // namespace ainvr::llm

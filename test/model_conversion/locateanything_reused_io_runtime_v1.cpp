// Copyright AINVR. Experimental S100P shared-HBM runner using the installed
// public DNN/UCP API. No SDK source is modified and no neural CPU path exists.
// Input/output DMA storage persists per static program; returned arrays own
// independent host copies. A failed wait quarantines all hardware resources.
#include <hobot/dnn/hb_dnn.h>
#include <hobot/hb_ucp.h>
#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>
namespace py = pybind11;
using Clock = std::chrono::steady_clock;
using Inputs = std::unordered_map<std::string, std::unordered_map<std::string, py::array>>;
static std::atomic<bool> poisoned{false};
static void check(int rc, const char* op) {
  if (rc) throw std::runtime_error(std::string(op) + ": " + std::to_string(rc));
}
static double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double,std::milli>(b-a).count();
}
static py::dtype dtype(int type) {
  switch (type) {
    case HB_DNN_TENSOR_TYPE_F32: return py::dtype::of<float>();
    case HB_DNN_TENSOR_TYPE_F16: return py::dtype("float16");
    case HB_DNN_TENSOR_TYPE_S32: return py::dtype::of<int32_t>();
    case HB_DNN_TENSOR_TYPE_S64: return py::dtype::of<int64_t>();
    case HB_DNN_TENSOR_TYPE_U8: return py::dtype::of<uint8_t>();
    default: throw std::runtime_error("Unsupported static experiment tensor type");
  }
}
struct Port {
  std::string name;
  hbDNNTensor tensor{};
  std::vector<ssize_t> shape, strides;
  ssize_t element_size=0, elements=0;
  bool contiguous=false;
};
struct Program {
  hbDNNHandle_t handle=nullptr;
  std::vector<Port> inputs, outputs;
  std::vector<hbDNNTensor> input_descriptors, output_descriptors;
  bool allocated=false;
};
struct State {
  hbDNNPackedHandle_t packed=nullptr;
  hbUCPTaskHandle_t inflight=nullptr;
  std::map<std::string,Program> programs;
  std::map<std::string,double> stats;
  ~State() {
    for (auto& [name,p]:programs) for (auto* ports:{&p.inputs,&p.outputs})
      for (auto& port:*ports) if (port.tensor.sysMem.virAddr) hbUCPFree(&port.tensor.sysMem);
    if (packed) hbDNNRelease(packed);
  }
};
class ReusedRuntime {
  std::unique_ptr<State> state_;
  const std::thread::id owner_=std::this_thread::get_id();
  bool running_=false;
  void owned() const {
    if (owner_!=std::this_thread::get_id()) throw std::runtime_error("Runtime owner thread differs");
    if (!state_ || poisoned.load()) throw std::runtime_error("Runtime closed or quarantined");
  }
  static Port metadata(hbDNNHandle_t h,int index,bool input) {
    Port p; const char* name=nullptr;
    check(input?hbDNNGetInputName(&name,h,index):hbDNNGetOutputName(&name,h,index),"tensor name");
    p.name=name; auto& q=p.tensor.properties;
    check(input?hbDNNGetInputTensorProperties(&q,h,index):hbDNNGetOutputTensorProperties(&q,h,index),"tensor properties");
    const int rank=q.validShape.numDimensions;
    if (rank<1 || rank>HB_DNN_TENSOR_MAX_DIMENSIONS) throw std::runtime_error("Invalid static tensor rank");
    p.element_size=dtype(q.tensorType).itemsize(); p.elements=1;
    for (int k=rank-1;k>=0;--k) {
      const int64_t dim=q.validShape.dimensionSize[k];
      if (dim<=0 || p.elements>std::numeric_limits<int64_t>::max()/dim) throw std::runtime_error("Invalid static tensor dimensions");
      p.elements*=dim;
      if (q.stride[k]==-1 && input && k<rank-1) {
        int64_t next=q.validShape.dimensionSize[k+1];
        if (q.stride[k+1]>(std::numeric_limits<int64_t>::max()-31)/next) throw std::runtime_error("Stride overflow");
        q.stride[k]=(q.stride[k+1]*next+31)&~int64_t(31);
      }
      if (q.stride[k]<=0) throw std::runtime_error("Unsupported dynamic stride");
    }
    int64_t extent=p.element_size;
    for (int k=0;k<rank;++k) {
      const auto dim=q.validShape.dimensionSize[k];
      if ((dim-1) && q.stride[k]>(std::numeric_limits<int64_t>::max()-extent)/(dim-1)) throw std::runtime_error("Tensor extent overflow");
      extent+=(dim-1)*q.stride[k];p.shape.push_back(dim);p.strides.push_back(q.stride[k]);
    }
    if (input) {
      if (q.stride[0]>std::numeric_limits<int64_t>::max()/p.shape[0]) throw std::runtime_error("Aligned input size overflow");
      q.alignedByteSize=std::max<int64_t>(q.alignedByteSize,q.stride[0]*p.shape[0]);
    }
    if (q.alignedByteSize<extent || q.alignedByteSize<=0) throw std::runtime_error("Tensor exceeds allocation");
    ssize_t stride=p.element_size;p.contiguous=true;
    for (int k=rank-1;k>=0;--k) {p.contiguous &= p.strides[k]==stride;stride*=p.shape[k];}
    return p;
  }
  void allocate(Program& p) {
    if (p.allocated) return;
    for (auto* ports:{&p.inputs,&p.outputs}) for (auto& port:*ports) {
      if (port.tensor.sysMem.virAddr) continue;
      check(hbUCPMallocCached(&port.tensor.sysMem,port.tensor.properties.alignedByteSize,0),"allocate persistent IO");
      state_->stats[ports==&p.inputs?"input_allocations":"output_allocations"]+=1;
      state_->stats["retained_io_bytes"]+=port.tensor.properties.alignedByteSize;
    }
    for (auto& port:p.inputs) p.input_descriptors.push_back(port.tensor);
    for (auto& port:p.outputs) p.output_descriptors.push_back(port.tensor);
    p.allocated=true;
  }
  static void copy_strided(char* dst,const char* src,const Port& p,bool to_device) {
    if (p.contiguous) {std::memcpy(dst,src,p.elements*p.element_size);return;}
    // Pure layout copying, with no tensor arithmetic or neural computation.
    if (to_device) std::memset(dst,0,p.tensor.properties.alignedByteSize);
    ssize_t block=p.element_size;int prefix=static_cast<int>(p.shape.size());
    while (prefix>0 && p.strides[prefix-1]==block) {--prefix;block*=p.shape[prefix];}
    ssize_t count=p.elements*p.element_size/block;
    for (ssize_t flat=0;flat<count;++flat) {
      ssize_t n=flat, offset=0;
      for (int k=prefix-1;k>=0;--k) {offset+=(n%p.shape[k])*p.strides[k];n/=p.shape[k];}
      if (to_device) std::memcpy(dst+offset,src+flat*block,block);
      else std::memcpy(dst+flat*block,src+offset,block);
    }
  }
 public:
  explicit ReusedRuntime(const std::string& path):state_(std::make_unique<State>()) {
    if (poisoned.load()) throw std::runtime_error("Hardware fault already latched");
    const char* file=path.c_str();check(hbDNNInitializeFromFiles(&state_->packed,&file,1),"load HBM");
    const char** names=nullptr;int32_t count=0;
    check(hbDNNGetModelNameList(&names,&count,state_->packed),"program names");
    if (count<1 || count>64) throw std::runtime_error("Invalid program count");
    for (int i=0;i<count;++i) {
      Program p;check(hbDNNGetModelHandle(&p.handle,state_->packed,names[i]),"program handle");
      for (bool input:{true,false}) {
        int32_t size=0;check(input?hbDNNGetInputCount(&size,p.handle):hbDNNGetOutputCount(&size,p.handle),"port count");
        if (size<1 || size>128) throw std::runtime_error("Invalid port count");
        auto& ports=input?p.inputs:p.outputs;
        for (int k=0;k<size;++k) ports.push_back(metadata(p.handle,k,input));
      }
      state_->programs.emplace(names[i],std::move(p));
    }
  }
  ~ReusedRuntime() {
    // DMA ownership must survive an unproven completion or wrong-thread close.
    if (state_ && (state_->inflight || owner_!=std::this_thread::get_id())) {poisoned.store(true);state_.release();}
  }
  void close() {owned();if (running_) throw std::runtime_error("Runtime still running");state_.reset();}
  std::vector<std::string> names() const {owned();std::vector<std::string> r;for (auto& [n,p]:state_->programs)r.push_back(n);return r;}
  std::map<std::string,std::vector<std::string>> port_names(bool inputs) const {
    owned();std::map<std::string,std::vector<std::string>> r;
    for (auto& [n,p]:state_->programs) for (auto& port:inputs?p.inputs:p.outputs) r[n].push_back(port.name);
    return r;
  }
  std::map<std::string,double> stats() const {owned();return state_->stats;}
  Inputs run(const Inputs& data) {
    owned();if (running_ || data.size()!=1) throw std::runtime_error("Exactly one synchronous program required");
    const auto& [name,values]=*data.begin();auto it=state_->programs.find(name);
    if (it==state_->programs.end()) throw std::runtime_error("Unknown program");
    auto& p=it->second;
    if (values.size()!=p.inputs.size()) throw std::runtime_error("Input port count differs");
    // Validate every array before touching device memory or submitting a task.
    for (auto& port:p.inputs) {
      auto found=values.find(port.name);if (found==values.end()) throw std::runtime_error("Input name differs");
      const auto& a=found->second;
      if (!a.dtype().is(dtype(port.tensor.properties.tensorType)) || a.ndim()!=static_cast<ssize_t>(port.shape.size()) || !(a.flags()&py::array::c_style)) throw std::runtime_error("Input dtype/rank/contiguity differs");
      for (ssize_t i=0;i<a.ndim();++i) if (a.shape(i)!=port.shape[i]) throw std::runtime_error("Input shape differs");
    }
    struct Guard {bool& flag;~Guard(){flag=false;}} guard{running_};running_=true;
    auto began=Clock::now();allocate(p);auto allocated=Clock::now();
    for (auto& port:p.inputs) {
      copy_strided(static_cast<char*>(port.tensor.sysMem.virAddr),static_cast<const char*>(values.at(port.name).data()),port,true);
      check(hbUCPMemFlush(&port.tensor.sysMem,HB_SYS_MEM_CACHE_CLEAN),"clean input");
    }
    auto copied=Clock::now();hbUCPTaskHandle_t task=nullptr;
    check(hbDNNInferV2(&task,p.output_descriptors.data(),p.input_descriptors.data(),p.handle),"create task");
    hbUCPSchedParam sched;HB_UCP_INITIALIZE_SCHED_PARAM(&sched);sched.backend=1;
    int rc=hbUCPSubmitTask(task,&sched);
    if (rc) {hbUCPReleaseTask(task);check(rc,"submit task");}
    state_->inflight=task;
    {
      py::gil_scoped_release release;
      rc=hbUCPWaitTaskDone(task,10000);
    }
    if (rc) {poisoned.store(true);throw std::runtime_error("Wait failed; all DMA/HBM resources quarantined until process exit");}
    // A successful wait proves completion. Retain custody if release fails.
    rc=hbUCPReleaseTask(task);
    if (rc) {poisoned.store(true);throw std::runtime_error("Task release failed; resources quarantined");}
    state_->inflight=nullptr;auto waited=Clock::now();Inputs result;
    for (auto& port:p.outputs) {
      check(hbUCPMemFlush(&port.tensor.sysMem,HB_SYS_MEM_CACHE_INVALIDATE),"invalidate output");
      py::array a(dtype(port.tensor.properties.tensorType),port.shape);
      copy_strided(static_cast<char*>(a.mutable_data()),static_cast<const char*>(port.tensor.sysMem.virAddr),port,false);
      result[name].emplace(port.name,std::move(a));
    }
    auto done=Clock::now();auto& s=state_->stats;s["calls"]+=1;s["allocation_ms"]+=ms(began,allocated);
    s["copy_clean_ms"]+=ms(allocated,copied);s["submit_wait_release_ms"]+=ms(copied,waited);
    s["invalidate_host_copy_ms"]+=ms(waited,done);s["total_ms"]+=ms(began,done);
    return result;
  }
};
PYBIND11_MODULE(_locate_reused_io_v1,m) {
  py::class_<ReusedRuntime>(m,"Runtime")
    .def(py::init<const std::string&>()).def("run",&ReusedRuntime::run).def("close",&ReusedRuntime::close)
    .def_property_readonly("model_names",&ReusedRuntime::names)
    .def_property_readonly("input_names",[](const ReusedRuntime& r){return r.port_names(true);})
    .def_property_readonly("output_names",[](const ReusedRuntime& r){return r.port_names(false);})
    .def_property_readonly("reuse_stats",&ReusedRuntime::stats);
}

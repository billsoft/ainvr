// Copyright AINVR. Fake SDK fault injection; this test performs no inference.
#include "platform/bpu.hpp"
#include <hobot/hb_ucp_status.h>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
namespace {
int wait_rc=0,release_rc=0,submit_rc=0,frees=0,releases=0,unloads=0,wait_ms=0,submits=0;
void Require(bool x){if(!x)throw std::runtime_error("BPU resource custody assertion failed");}
void Properties(hbDNNTensorProperties* p){*p={};p->validShape.numDimensions=1;p->validShape.dimensionSize[0]=4;p->stride[0]=1;p->alignedByteSize=4;}
}
extern "C" {
const char* hbDNNGetVersion(){return "fake-test-only";}
const char* hbUCPGetVersion(){return "fake-test-only";}
const char* hbUCPGetSocName(){return "fake-test-only";}
int32_t hbDNNInitializeFromFiles(hbDNNPackedHandle_t* p,const char**,int32_t){*p=reinterpret_cast<void*>(1);return 0;}
int32_t hbDNNGetModelNameList(const char*** names,int32_t* count,hbDNNPackedHandle_t){static const char* a[]={"fake"};*names=a;*count=1;return 0;}
int32_t hbDNNGetModelHandle(hbDNNHandle_t* p,hbDNNPackedHandle_t,const char*){*p=reinterpret_cast<void*>(2);return 0;}
int32_t hbDNNGetInputCount(int32_t* n,hbDNNHandle_t){*n=1;return 0;}
int32_t hbDNNGetOutputCount(int32_t* n,hbDNNHandle_t){*n=1;return 0;}
int32_t hbDNNGetInputTensorProperties(hbDNNTensorProperties* p,hbDNNHandle_t,int32_t){Properties(p);return 0;}
int32_t hbDNNGetOutputTensorProperties(hbDNNTensorProperties* p,hbDNNHandle_t,int32_t){Properties(p);return 0;}
int32_t hbDNNGetInputName(const char** p,hbDNNHandle_t,int32_t){*p="input";return 0;}
int32_t hbDNNGetOutputName(const char** p,hbDNNHandle_t,int32_t){*p="output";return 0;}
int32_t hbUCPMallocCached(hbUCPSysMem* p,uint64_t n,int32_t){p->virAddr=std::calloc(1,n);return p->virAddr?0:-1;}
int32_t hbUCPMemFlush(const hbUCPSysMem*,int32_t){return 0;}
int32_t hbUCPFree(hbUCPSysMem* p){++frees;std::free(p->virAddr);p->virAddr=nullptr;return 0;}
int32_t hbDNNRelease(hbDNNPackedHandle_t){++unloads;return 0;}
int32_t hbDNNInferV2(hbUCPTaskHandle_t* p,hbDNNTensor*,const hbDNNTensor*,hbDNNHandle_t){*p=reinterpret_cast<void*>(3);return 0;}
int32_t hbUCPSubmitTask(hbUCPTaskHandle_t,hbUCPSchedParam*){++submits;return submit_rc;}
int32_t hbUCPWaitTaskDone(hbUCPTaskHandle_t,int32_t ms){wait_ms=ms;return wait_rc;}
int32_t hbUCPReleaseTask(hbUCPTaskHandle_t){++releases;return release_rc;}
}
int main(int argc,char** argv){try{
  Require(argc==2);const std::string mode=argv[1];
  if(mode=="timeout")wait_rc=HB_UCP_TASK_TIMEOUT;
  else if(mode=="unknown")wait_rc=HB_UCP_UNKNOWN_ERROR;
  else if(mode=="release")release_rc=HB_UCP_API_USE_ERROR;
  else if(mode=="submit")submit_rc=HB_UCP_TASK_NUMBER_EXCEED_LIMIT;
  else Require(mode=="success");
  const bool fault=mode=="timeout"||mode=="unknown"||mode=="release";
  {ainvr::BpuModel model("fake-never-opened");
    bool threw=false;try{auto out=model.Run({{1,2,3,4}});Require(out.size()==1&&out[0].size()==4);}catch(const std::runtime_error&){threw=true;}
    Require(threw==(mode!="success"));Require(ainvr::BpuRuntimeHealthy()!=fault);
    if(fault){const int before=submits;try{model.Run({{1,2,3,4}});Require(false);}catch(const std::runtime_error&){}Require(submits==before);}
  }
  Require(wait_ms==(mode=="submit"?0:10000));
  Require(frees==(fault?0:2));Require(unloads==(fault?0:1));
  Require(releases==((mode=="timeout"||mode=="unknown")?0:1));
  Require(ainvr::BpuQuarantinedBytes()==(fault?8u:0u));
  if(fault){bool rejected=false;try{ainvr::BpuModel blocked("fake");}catch(const std::runtime_error&){rejected=true;}Require(rejected);}
  std::cout<<"PASS "<<mode<<"; fake SDK, zero neural calls\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

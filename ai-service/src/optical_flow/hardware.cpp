// Copyright AINVR. JPU -> PYM/GLES resize -> median -> BPU -> Gaussian -> mean.
#include "runtime.hpp"
#include "filters.hpp"
#include "scene_match.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/model_digest.hpp"
#include "platform/tensor_decode.hpp"
#include "platform/vpu_decoder.hpp"
#include "../../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../../shared/cpp/bpu_reserved_pool.hpp"
#include "../../../shared/cpp/bpu_dma_buffer.hpp"
#include <fcntl.h>
#include <unistd.h>
#include <filesystem>
namespace ainvr::flow {
namespace {
struct Reservation {
  std::unique_ptr<BpuCoexistReservation> held;
  Reservation(){
    if(!BpuRuntimeHealthy())throw Error(503,"flow_bpu_fault");
    IonPolicy policy;policy.pool_bytes=ReadBpuIonBudgetBytes();
    held=std::make_unique<BpuCoexistReservation>("/run/ainvr","ai-service",76ULL<<20,policy);
  }
  ~Reservation(){if(!BpuRuntimeHealthy())(void)held.release();}
};
class Verified {
 public:
  Verified(const std::string& path,const std::string& hash):path_(path){
    fd_=open(path.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd_<0)throw Error(503,"flow_model_missing");
    try{
      identity_=ModelDigestCache::Identify(fd_);static ModelDigestCache cache;
      if(cache.Get(fd_)!=hash)throw Error(503,"flow_model_hash_mismatch");
    }catch(...){close(fd_);fd_=-1;throw;}
  }
  ~Verified(){if(fd_>=0)close(fd_);}
  std::string Path()const{return "/proc/self/fd/"+std::to_string(fd_);}
  void CheckIdentity(){
    struct stat st{};
    if(ModelDigestCache::Identify(fd_)!=identity_||stat(path_.c_str(),&st)||
       st.st_dev!=std::get<0>(identity_)||st.st_ino!=std::get<1>(identity_))throw Error(503,"flow_model_changed");
  }
 private:int fd_=-1;std::string path_;ModelDigestCache::Identity identity_;
};
class Hardware:public Backend {
 public:
  explicit Hardware(const std::string& root){
    auto path=(std::filesystem::path(root)/kModel).string();
    Verified contract(path+".ainvr.json",kContractSha),model(path,kModelSha);
    // Missing/incorrect optional models must fail before touching the ION ledger.
    reservation_=std::make_unique<Reservation>();
    model_=BpuModel::Acquire(model.Path(),"neuflow");model.CheckIdentity();contract.CheckIdentity();
    desc_=model_->Describe();
    if(desc_.at("inputs").size()!=2||desc_.at("outputs").size()!=1)throw Error(503,"flow_tensor_contract");
    for(int i=0;i<3;++i){
      const auto& d=i<2?desc_["inputs"][i]:desc_["outputs"][0];
      if(d.at("shape")!=Json::array({1,i<2?3:2,kHeight,kWidth})||
         d.at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||d.at("quantization")!=NONE||
         d.at("name")!=(i==0?"img0":i==1?"img1":"flow"))throw Error(503,"flow_tensor_contract");
    }
    images_=std::make_unique<ImagePreprocessor>(PreprocessorOptions{true,true,false});
    filters_=std::make_unique<Filters>();
    {BpuDmaBuffer probe(256ULL<<20);}reservation_->held->Loaded();
  }
  Json Run(const std::vector<uint8_t>& a,const std::vector<uint8_t>& b,const Current& current)override{
    auto start=std::chrono::steady_clock::now();Check(current);
    auto first=Prepare(a,current),second=Prepare(b,current);Check(current);
    if(!BpuRuntimeHealthy())throw Error(503,"flow_bpu_fault");
    auto inference=std::chrono::steady_clock::now();
    auto raw=model_->Run({PackBpuFloatNchw(first.chw,desc_["inputs"][0]),PackBpuFloatNchw(second.chw,desc_["inputs"][1])});
    auto inferred=std::chrono::steady_clock::now();Check(current);
    if(raw.size()!=1)throw Error(503,"flow_output_contract");
    auto flow=DecodeTensor(raw[0],desc_["outputs"][0]);
    auto result=Reduce(filters_->Gaussian(flow));Check(current);
    result["schema"]="ainvr.ptz-flow.v1";
    result["inputFilter"]="gles-median-3x3";result["flowFilter"]="gles-gaussian-3x3-binomial";
    result["resizeBackends"]=Json::array({first.backend,second.backend});
    result["resizeReasons"]=Json::array({first.fallback_reasons,second.fallback_reasons});
    result["modelSha256"]=kModelSha;result["contractSha256"]=kContractSha;
    result["accuracyVerified"]=false;result["productionApproved"]=false;
    result["inferenceMs"]=std::chrono::duration<double,std::milli>(inferred-inference).count();
    result["processingMs"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    return result;
  }
  Json Match(const std::vector<uint8_t>& a,const std::vector<uint8_t>& b,const Current& current)override{
    Check(current);
    const auto [aw,ah]=ai_service::analytics::JpegDimensions(a);
    const auto [bw,bh]=ai_service::analytics::JpegDimensions(b);
    if(int64_t(aw)*bh!=int64_t(bw)*ah)throw Error(422,"scene_aspect_changed");
    auto first=Prepare(a,current),second=Prepare(b,current);
    auto infer=[&](const std::vector<float>& left,const std::vector<float>& right){
      Check(current);
      if(!BpuRuntimeHealthy())throw Error(503,"flow_bpu_fault");
      auto raw=model_->Run({PackBpuFloatNchw(left,desc_["inputs"][0]),PackBpuFloatNchw(right,desc_["inputs"][1])});
      Check(current);
      if(raw.size()!=1)throw Error(503,"flow_output_contract");
      return filters_->Gaussian(DecodeTensor(raw[0],desc_["outputs"][0]));
    };
    auto forward=infer(first.chw,second.chw),backward=infer(second.chw,first.chw);
    auto result=MatchScene(forward,backward,first.chw,second.chw);
    if(result.at("matched")==true){
      Check(current);
      const auto ref=filters_->SceneDescriptors(first.chw);
      Check(current);
      const auto target=filters_->SceneDescriptors(second.chw);
      Check(current);
      result["localEvidence"]=SceneEvidence(result.at("homography").get<Homography>(),
          forward,backward,ref,target);
    }
    Check(current);return result;
  }
 private:
  PreprocessedImage Prepare(const std::vector<uint8_t>& jpeg,const Current& current){
    auto [w,h]=ai_service::analytics::JpegDimensions(jpeg);Check(current);
    VpuDecoder decoder(Codec::Jpeg,(w+1)&~1,(h+1)&~1,JpegOutputLayout::EvenPaddedSurface);
    while(!decoder.Submit(jpeg,0,50))Check(current);
    std::optional<Nv12Frame> frame;
    while(!frame){Check(current);frame=decoder.Receive(50);}Check(current);
    if(frame->visible_width!=w||frame->visible_height!=h||frame->width<w||frame->height<h)
      throw Error(503,"flow_jpeg_dimensions");
    ImageTransform t;t.width=kWidth;t.height=kHeight;t.letterbox=false;t.bgr=true;
    t.mean={0,0,0};t.divisor={1,1,1};t.yuv_bt709=false;t.yuv_full_range=true;
    if(frame->width!=w||frame->height!=h)t.source_region=std::array<float,4>{0,0,float(w),float(h)};
    auto image=images_->RunNv12(*frame,t);Check(current);
    image.chw=filters_->Median(image.chw);Check(current);return image;
  }
  std::unique_ptr<Reservation> reservation_; // destroyed AFTER SDK/images/GPU; quarantine on fault
  std::shared_ptr<BpuModel>model_;Json desc_;
  std::unique_ptr<ImagePreprocessor>images_;std::unique_ptr<Filters>filters_;
};
}
Factory NativeFactory(std::string root){return [root=std::move(root)]{return std::make_unique<Hardware>(root);};}
}

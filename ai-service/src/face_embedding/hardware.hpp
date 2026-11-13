// Copyright AINVR. Single-thread JPU/GLES/BPU path. No CPU pixel fallback.
#pragma once
#include "extractor.hpp"
#include "adapters/detection_decode.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/gles_preprocess.hpp"
#include "platform/model_digest.hpp"
#include "platform/tensor_decode.hpp"
#include "platform/vpu_decoder.hpp"
#include <fcntl.h>
#include <unistd.h>

namespace ainvr::face {
class VerifiedModel {
 public:
  explicit VerifiedModel(const ModelSpec& spec):path_(spec.path) {
    fd_=open(path_.c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd_<0)throw std::runtime_error("face_model_unavailable");
    try{
      identity_=ModelDigestCache::Identify(fd_);
      static ModelDigestCache digests;
      if(std::get<2>(identity_)!=off_t(spec.bytes)||digests.Get(fd_)!=spec.hbm_hash)
        throw std::runtime_error("face_model_hash_mismatch");
    }catch(...){close(fd_);fd_=-1;throw;}
  }
  ~VerifiedModel(){if(fd_>=0)close(fd_);}
  VerifiedModel(const VerifiedModel&)=delete;
  std::shared_ptr<BpuModel> Acquire(const std::function<void(std::weak_ptr<void>)>& observe) {
    // Keep the verified inode open across SDK load. Never reopen unverified bytes.
    auto model=BpuModel::Acquire("/proc/self/fd/"+std::to_string(fd_));
    // Acquire has already registered configured residency. Account for that
    // resource even if the following inode revalidation rejects replacement.
    if(observe)observe(model);
    if(ModelDigestCache::Identify(fd_)!=identity_)throw std::runtime_error("face_model_changed");
    struct stat named{};if(stat(path_.c_str(),&named)||named.st_ino!=std::get<1>(identity_)||named.st_dev!=std::get<0>(identity_))
      throw std::runtime_error("face_model_replaced");
    return model;
  }
 private:
  int fd_=-1;std::string path_;ModelDigestCache::Identity identity_;
};

class Hardware final:public Extractor {
 public:
  Hardware(const Settings& settings,BudgetLease budget,const Current& current)
      :settings_(settings),budget_(std::move(budget)) {
    Check(current);
    VerifiedModel detector(settings.detector),embedding(settings.embedding);
    detect_=detector.Acquire(budget_.observe_model);
    Check(current);embed_=embedding.Acquire(budget_.observe_model);
    Check(current);
    dd_=detect_->Describe();ed_=embed_->Describe();
    CheckInput(dd_,640);CheckInput(ed_,112);
    if(ed_.at("outputs").size()!=1||ed_.at("outputs").at(0).at("shape")!=Json::array({1,512})||
        ed_.at("outputs").at(0).at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||
        ed_.at("outputs").at(0).at("quantization")!=NONE||dd_.at("outputs").size()!=9)
      throw std::runtime_error("face_runtime_tensor_contract");
    for(const auto* key:{"inputs","outputs"}){
      const auto& side=settings.embedding.manifest.at(key).begin();
      if(ed_.at(key).at(0).at("name")!=side.key())throw std::runtime_error("face_runtime_port_contract");
    }
    const auto& expected=settings.detector.manifest;
    for(const auto* key:{"inputs","outputs"})for(size_t i=0;i<dd_.at(key).size();++i)
      if(dd_.at(key).at(i).at("name")!=expected.at(key).at(i).at("name")||
          dd_.at(key).at(i).at("shape")!=expected.at(key).at(i).at("shape"))
        throw std::runtime_error("face_detector_port_contract");
    // No graphics or model resources are constructed without admission.
    images_=std::make_unique<GlesPreprocessor>();
    if(budget_.loaded)budget_.loaded();
    Check(current);
  }
  Result Extract(const std::vector<uint8_t>& jpeg,const Current& current) override {
    Check(current);const auto [w,h]=ai_service::analytics::JpegDimensions(jpeg);
    if(w<16||h<16||w>4096||h>4096||uint64_t(w)*h>8ULL*1024*1024)
      throw std::invalid_argument("unsupported_face_image");
    // Decoder capacities are NV12/even; the JPEG's visible dimensions remain
    // unchanged and are checked below before GLES removes the padding.
    VpuDecoder decoder(Codec::Jpeg,(w+1)&~1,(h+1)&~1,JpegOutputLayout::EvenPaddedSurface);
    // Current includes the request's hard deadline; no unbounded codec loop.
    while(!decoder.Submit(jpeg,0,50))Check(current);
    std::optional<Nv12Frame> frame;
    while(!frame){Check(current);frame=decoder.Receive(50);}Check(current);
    if(frame->visible_width!=w||frame->visible_height!=h||frame->width<w||frame->height<h)
      throw std::runtime_error("face_jpeg_dimensions_mismatch");
    // Crop away MCU/even padding on GLES, preserving odd visible JPEG extents.
    ImageTransform original;original.width=w;original.height=h;original.letterbox=false;
    original.source_region=std::array<float,4>{0,0,float(w),float(h)};
    original.yuv_bt709=false;original.yuv_full_range=true;
    auto rgba=images_->RunNv12Rgba(frame->pixels,frame->width,frame->height,original);Check(current);
    frame.reset();
    ImageTransform detection;detection.mean={127.5f,127.5f,127.5f};detection.divisor={128,128,128};
    auto tensors=Infer(*detect_,dd_,images_->Run(rgba,w,h,detection),current);
    std::vector<DenseTensor> outputs;
    for(size_t i=0;i<tensors.size();++i)outputs.push_back({dd_.at("outputs").at(i).at("name"),
      dd_.at("outputs").at(i).at("shape").get<std::vector<int64_t>>(),std::move(tensors[i])});
    // Keep a second low-score candidate: it must not be hidden by choosing the
    // largest face or truncating to one before single-face validation.
    const auto faces=DecodeScrfd(outputs,ai_service::pipeline::compute_scale(w,h,640,640),{.25,.4,2});
    Result result;result.space_hash=settings_.space_hash;
    if(faces.size()!=1){result.status=faces.empty()?"no_face":"multiple_faces";result.quality.reason=result.status;return result;}
    const auto& face=faces[0];Candidate c;c.box=face.bbox;c.detection_score=face.confidence;
    c.has_landmarks=face.landmarks&&face.landmarks->size()==5;
    if(c.has_landmarks)std::copy(face.landmarks->begin(),face.landmarks->end(),c.landmarks.begin());
    Similarity similarity;result.quality=Assess(c,w,h,similarity);
    if(!result.quality.accepted){result.status="quality_rejected";return result;}
    Check(current);ImageTransform align;align.width=align.height=112;align.letterbox=false;
    align.padding={0,0,0};align.projective_uv=similarity.SourceUv(w,h);
    auto aligned=images_->RunRgbaRgba(rgba,w,h,align);Check(current);
    ImageTransform normalize;normalize.width=normalize.height=112;normalize.letterbox=false;
    normalize.mean={127.5f,127.5f,127.5f};normalize.divisor={127.5f,127.5f,127.5f};
    auto vectors=Infer(*embed_,ed_,images_->Run(aligned,112,112,normalize),current);
    result.embedding=Normalize(vectors.at(0));Check(current);result.status="extracted";return result;
  }
 private:
  void Check(const Current& current) const {
    if(owner_!=std::this_thread::get_id())throw std::logic_error("face_hardware_thread_mismatch");
    if(!current||!current()||!budget_.Valid())throw std::runtime_error("face_request_expired");
    if(!BpuRuntimeHealthy())throw std::runtime_error("face_bpu_fault");
  }
  static void CheckInput(const Json& description,int size) {
    const auto& inputs=description.at("inputs");
    if(inputs.size()!=1||inputs.at(0).at("shape")!=Json::array({1,3,size,size})||
        inputs.at(0).at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||inputs.at(0).at("quantization")!=NONE)
      throw std::runtime_error("face_runtime_input_contract");
  }
  std::vector<std::vector<float>> Infer(BpuModel& model,const Json& desc,const std::vector<float>& input,const Current& current) {
    Check(current);auto raw=model.Run(PackBpuFloatInputs(input,desc.at("inputs"),"",{}));Check(current);
    if(raw.size()!=desc.at("outputs").size())throw std::runtime_error("face_output_count");
    std::vector<std::vector<float>> out;
    for(size_t i=0;i<raw.size();++i)out.push_back(DecodeTensor(raw[i],desc.at("outputs").at(i)));
    return out;
  }
  Settings settings_;BudgetLease budget_; // retained until all hardware below is destroyed
  std::shared_ptr<BpuModel> detect_,embed_;
  Json dd_,ed_;std::unique_ptr<GlesPreprocessor> images_;
  std::thread::id owner_=std::this_thread::get_id();
};
inline ExtractorFactory NativeFactory() {
  return [](const Settings& s,BudgetLease budget,const Current& current){
    return std::make_unique<Hardware>(s,std::move(budget),current);};
}
} // namespace ainvr::face

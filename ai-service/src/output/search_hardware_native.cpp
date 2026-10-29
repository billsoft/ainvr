#include "output/search_hardware_owner.hpp"
#include "output/search_hardware_plan.hpp"
#include "output/snapshot_renderer.hpp"
#include "platform/bpu.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include "platform/vpu_decoder.hpp"
#include "../../../search-service/src/bpu_vision_encoder.hpp"
namespace ai_service::output {
namespace {
class NativeSession final:public SearchHardwareSession {
 public:
  NativeSession(const std::string& package,SearchHardwareNativeOptions options,
      const std::optional<ainvr::search::RuntimeModelPin>& expected,const SearchSamplingCurrent& current):options_(options),
      renderer_({},ainvr::SnapshotEncodingPolicy::HardwareOnly){
    if(options.jpeg_quality<1||options.jpeg_quality>100)throw std::invalid_argument("search_hardware_quality_invalid");
    // Validate bounded policy before package hashing or SDK/DMA allocation.
    SearchHardwarePlan({0,0,20,20},20,20,false,options.object_max_dimension,options.object_padding_ratio);
    SearchHardwarePlan({},20,20,true,options.scene_max_dimension,0);
    if(!current||!current())throw std::runtime_error("search_hardware_stale");
    if(expected&&(!ainvr::search::ValidRuntimeModelPin(*expected)||expected->package_id!=package))
      throw std::runtime_error("search_hardware_model_pin_mismatch");
    auto verified=ainvr::search::VerifyPackage(package);
    if(expected){
      const ainvr::search::RuntimeModelPin actual{verified.spec?verified.spec->id:"",
        verified.model_version.size()>=10?verified.model_version.substr(10):"",verified.model_version};
      if(!ainvr::search::ValidRuntimeModelPin(*expected)||!ainvr::search::MatchesRuntimeModelPin(*expected,actual))
        throw std::runtime_error("search_hardware_model_pin_mismatch");
    }
    // Verification may be slow. A Stop, expired lease or changed pin during it
    // must not allocate the old vision model even if it will never become Ready.
    if(!current||!current())throw std::runtime_error("search_hardware_stale");
    encoder_=ainvr::search::BpuVisionEncoder::Load(std::move(verified));
    space_={package,encoder_->ModelVersion(),encoder_->InputSpecVersion()};
  }
  SearchEmbeddingSpace Space() const override{return space_;}
  std::function<bool()> HealthReader() const override{return []{return ainvr::BpuRuntimeHealthy();};}
  SearchHardwareProduct Prepare(const FrozenSearchFrame& frame,const SearchSamplingCurrent& current)override{
    if(!current||!current()||!ainvr::BpuRuntimeHealthy())throw std::runtime_error("search_hardware_stale");
    const bool scene=!frame.Selection().slot;
    if(!scene&&!frame.RawTargetBox())throw std::runtime_error("search_hardware_target_missing");
    const auto& raw=frame.Pixels();
    auto plan=SearchHardwarePlan(scene?std::array<double,4>{}:*frame.RawTargetBox(),raw.width,raw.height,scene,
      scene?options_.scene_max_dimension:options_.object_max_dimension,options_.object_padding_ratio);
    auto image=renderer_.RenderPlanned(raw,plan,options_.jpeg_quality,frame.Bt709(),frame.FullRange());
    if(!current())throw std::runtime_error("search_hardware_stale");
    auto vision=encoder_->Encode(raw,plan,frame.Bt709(),frame.FullRange());
    if(!current())throw std::runtime_error("search_hardware_stale");
    return {image.plan,std::move(image.jpeg),std::move(vision.embedding),image.render_backend,image.encoder_backend,vision.image_backend};
  }
  SearchReencodeResult ReencodeJpeg(const std::vector<uint8_t>& jpeg,const SearchSamplingCurrent& current)override{
    auto check=[&]{if(!current||!current()||!ainvr::BpuRuntimeHealthy())throw std::runtime_error("search_hardware_stale");};
    check();const auto [width,height]=analytics::JpegDimensions(jpeg);
    if(jpeg.size()>kSearchReencodeMaxJpegBytes||width<16||height<16||width%2||height%2||
        size_t(width)*size_t(height)>kSearchReencodeMaxPixels)
      return {SearchReencodeResult::Status::Unsupported,{}, {},0,0};
    // JPEG display size remains authoritative. Driver padding is validated and
    // stripped by VpuDecoder; it is never interpreted as visible image pixels.
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,width,height);
    while(!decoder.Submit(jpeg,0,50))check();
    std::optional<ainvr::Nv12Frame> frame;
    while(!frame){check();frame=decoder.Receive(50);}
    check();
    if(frame->width!=width||frame->height!=height||frame->pixels.size()!=size_t(width)*height*3/2)
      throw std::runtime_error("search_reencode_decoded_dimensions_invalid");
    // Reuse the same validated full-source plan and GLES INTER_AREA encoder.
    // The retained original JPEG is not encoded again or overlaid/enhanced.
    // JPEG JPU output uses the existing review-image full-range BT.601 contract.
    auto plan=SearchHardwarePlan({},width,height,true,std::min(4096,std::max(width,height)),0);
    auto encoded=encoder_->Encode(*frame,plan,false,true);check();
    return {SearchReencodeResult::Status::Ready,space_,std::move(encoded.embedding),width,height};
  }
 private:
  SearchHardwareNativeOptions options_;
  ainvr::SnapshotRenderer renderer_;
  std::unique_ptr<ainvr::search::BpuVisionEncoder> encoder_;
  SearchEmbeddingSpace space_;
};
}
std::shared_ptr<SearchHardwareOwner> MakeNativeSearchHardwareOwner(SearchHardwareNativeOptions options){
  return std::make_shared<SearchHardwareOwner>([options](const std::string& package,
      const std::optional<ainvr::search::RuntimeModelPin>& expected,const SearchSamplingCurrent& current){
    return std::make_unique<NativeSession>(package,options,expected,current);});
}
}

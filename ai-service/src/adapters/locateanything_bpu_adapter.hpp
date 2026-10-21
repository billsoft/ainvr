// Copyright AINVR. Complete LocateAnything HBM model's own frame/result adapter.
// Factory exposure and release approval remain separate acceptance steps.
#pragma once
#include <fstream>
#include <filesystem>
#include <future>
#include "bpu_channel_adapter.hpp"
#include "runtime_label_catalog.hpp"
#include "utils/log.hpp"
#include "locateanything_result_decode.hpp"
#include "platform/locateanything_pillow_preprocess.hpp"
#include "platform/locateanything_executor_client.hpp"
#include "platform/locateanything_channel_lease.hpp"

namespace ai_service::adapters {
class LocateAnythingBpuAdapter final : public BpuChannelAdapter {
 public:
  explicit LocateAnythingBpuAdapter(config::ModelConfig cfg):BpuChannelAdapter(std::move(cfg)) {
    if(ModelConfig().adapter!="locateanything_bpu" || ModelConfig().name!="locateanything-3b")
      throw std::invalid_argument("LocateAnything requires its own model family");
  }
  nlohmann::json ValidateStartContract() const override {
    const auto& cfg=ModelConfig();
    if(cfg.adapter!="locateanything_bpu" || cfg.name!="locateanything-3b" || cfg.provider!="bpu" ||
       cfg.input_size!=std::vector<int>{224,448} || cfg.prompts.size()>kLocateAnythingMaximumSlots ||
       cfg.max_new_tokens<1 || cfg.max_new_tokens>256 ||
       std::filesystem::path(cfg.path).extension()!=".hbm" || !std::filesystem::is_regular_file(cfg.path))
      throw std::runtime_error("LocateAnything requires its own complete224x448 BPU contract");
    const auto sidecar=cfg.path+".ainvr.json";
    if(!std::filesystem::is_regular_file(sidecar) || std::filesystem::file_size(sidecar)>1024*1024)
      throw std::runtime_error("LocateAnything complete-model manifest is missing or oversized");
    std::ifstream file(sidecar);nlohmann::json m;file>>m;
    if(m.at("schema_version")!=1 || m.at("target")!="rdk_s100p" || m.at("adapter")!=cfg.adapter ||
       m.at("model_family")!="locateanything-3b" || m.at("architecture")!="original36_qwen_moonvit27_shared_programs" ||
       m.at("component_count")!=76 || m.at("physical_hbm_files")!=46 ||
       m.at("text_layers")!=36 || m.at("vision_blocks")!=27 || m.at("vocabulary_size")!=152681 ||
       m.at("input_size")!=nlohmann::json::array({224,448}) ||
       m.at("input_contract")!="complete-hbm-components-rgb-chw-v1" ||
       m.at("output_contract")!="locateanything_geometry_tokens_v1" ||
       m.at("image_resample")!="pillow9-bicubic-rgb8" || m.at("hbm_sha256")!=ModelFileDigest(cfg.path))
      throw std::runtime_error("LocateAnything full architecture/input/output/digest contract differs");
    const auto& generation=m.at("generation");
    if(generation.at("mode")!="slow" ||
       std::filesystem::path(generation.at("socket").get<std::string>()).lexically_normal().parent_path()!=
         std::filesystem::path("/home/sunrise/ainvr/data/ai"))
      throw std::runtime_error("LocateAnything native request endpoint or generation mode differs");
    // Constructor validates digest spelling and request bounds without a call.
    ainvr::LocateAnythingExecutorClient declared(generation.at("socket"),
      generation.at("contract_sha256"),generation.at("maximum_seconds"));
    return m;
  }
  std::pair<int,int> InputSize() const override {return {224,448};}
  bool IsMultiOutput() const override {return true;}
  bool ReportsGenerationStatus() const override {return true;}
  std::string TaskType() const override {return "open_vocabulary_detection";}
  // This transformer runs sequentially; it cannot share YOLO's two-frame queue.
  bool SupportsFramePipeline() const override {return false;}
  std::optional<EncodedFrameRetention> FrameRetention() const override {
    // Retention is metadata-only and remains readable for archived research
    // layouts;the common Start gate validates executable families separately.
    std::ifstream file(ModelConfig().path+".ainvr.json");
    if(!file)throw std::runtime_error("LocateAnything complete-model retention manifest is missing");
    nlohmann::json manifest;file>>manifest;
    if(manifest.at("model_family")!="locateanything-3b" || !CompleteLayout(manifest))
      throw std::runtime_error("LocateAnything complete-model retention identity differs");
    const double bound=manifest.at("generation").at("maximum_seconds").get<double>();
    const auto& media=manifest.at("media_retention");
    EncodedFrameRetention policy{media.at("delay_seconds").get<double>(),
      media.at("maximum_bytes").get<int64_t>(),media.at("maximum_frames").get<int64_t>(),
      media.at("spool_directory").get<std::string>()};
    if(!std::isfinite(bound)||bound<=0||bound>3600 || !std::isfinite(policy.delay_seconds) ||
       policy.delay_seconds!=bound+5 || policy.maximum_bytes!=int64_t(16)*1024*1024*1024 ||
       policy.maximum_frames!=static_cast<int64_t>(std::ceil(policy.delay_seconds*144.0))+1 ||
       policy.spool_directory!="/mnt/ainvr-ssd/ainvr-au-cache")
      throw std::runtime_error("LocateAnything declared video retention is invalid");
    return policy;
  }
  void SetCancellationProbe(std::function<bool()> cancelled) override {cancelled_=std::move(cancelled);}
  pipeline::PreprocessConfig DefaultPreprocess() const override {
    pipeline::PreprocessConfig p;p.letterbox=false;p.interpolation="bicubic";
    p.mean={127.5,127.5,127.5};p.std={127.5,127.5,127.5};p.rgb_order=true;
    return p;
  }
  void Load(const std::string& path,const std::string& provider,const std::string&) override {
    if(provider!="bpu" || ModelConfig().input_size!=std::vector<int>{224,448} ||
       std::filesystem::path(path).extension()!=".hbm" || !std::filesystem::is_regular_file(path))
      throw std::invalid_argument("LocateAnything requires the224x448 BPU image profile");
    if(path!=ModelConfig().path || provider!=ModelConfig().provider)
      throw std::runtime_error("LocateAnything load differs from declared model");
    const auto manifest=ValidateStartContract();
    if(manifest.at("model_family")!="locateanything-3b" ||
       manifest.at("input_contract")!="complete-hbm-components-rgb-chw-v1" ||
       manifest.at("input_size")!=nlohmann::json::array({224,448}) ||
       manifest.at("image_resample")!="pillow9-bicubic-rgb8" || !CompleteLayout(manifest))
      throw std::runtime_error("LocateAnything complete-model input contract differs");
    if(lease_ || client_ || images_)throw std::logic_error("LocateAnything adapter is already loaded");
    auto lease=std::make_unique<ainvr::LocateAnythingChannelLease>();
    const auto& generation=manifest.at("generation");
    auto client=std::make_unique<ainvr::LocateAnythingExecutorClient>(generation.at("socket"),
        generation.at("contract_sha256"),generation.at("maximum_seconds"));
    const auto health=client->Health();
    if(!health.value("ready",false) || health.value("neural_provider",std::string())!="bpu" ||
       health.value("neural_cpu_fallback",true) || health.value("component_count",0)!=manifest.at("component_count").get<int>() ||
       health.value("physical_hbm_files",0)!=46 ||
       health.value("compiled_profiles",nlohmann::json())!=nlohmann::json({{"prefill",256},{"decode",1},{"kv_capacity",512}}) ||
       (manifest.at("component_count")!=213 && health.value("architecture",std::string())!=manifest.at("architecture").get<std::string>()) ||
       health.at("input_size")!=nlohmann::json::array({224,448}) ||
       health.at("generation_mode")!=generation.at("mode") ||
       health.at("request_bound_seconds")!=generation.at("maximum_seconds"))
      throw std::runtime_error("Complete LocateAnything BPU executor is not ready for this manifest");
    const auto& cfg=ModelConfig();
    query_=LocateAnythingQuery(cfg);
    if(!client->Validate(query_,cfg.max_new_tokens).value("valid",false))
      throw std::invalid_argument("LocateAnything prompt exceeds the compiled profile");
    mode_=generation.at("mode").get<std::string>();
    auto images=std::make_unique<ainvr::LocateAnythingPillowPreprocessor>();
    lease_=std::move(lease);
    client_=std::move(client);
    images_=std::move(images);
  }
  ainvr::BpuImageResult RunFrame(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& p,
                               bool bt709,bool full_range) override {
    if(!client_ || !images_)throw std::logic_error("LocateAnything is not loaded");
    complete_=false;
    points_=nlohmann::json::array();
    const auto expected=DefaultPreprocess();
    if(p.letterbox || p.interpolation!="bicubic" || !p.normalize || !p.rgb_order ||
       p.mean!=expected.mean || p.std!=expected.std)
      throw std::invalid_argument("LocateAnything requires bicubic full-frame RGB normalization and no letterbox");
    const auto before=std::chrono::steady_clock::now();
    // Preserve original RGB8 resize semantics,including antialiasing and
    // intermediate byte rounding;generic bicubic/PYM are not equivalent.
    auto image=images_->RunNv12(frame.pixels,frame.width,frame.height,bt709,full_range);
    const auto preprocess_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-before).count();
    auto result=RunPreparedRgb(image);
    result.preprocess_ms=preprocess_ms;
    return result;
  }
  // Archived JPEG review uses the same verified executor and generation decoder.
  // Caller must use the declared Pillow RGB8 preprocessing, on the GLES owner thread.
  ainvr::BpuImageResult RunPreparedRgb(const std::vector<float>& image) {
    complete_=false;points_=nlohmann::json::array();
    if(!client_ || !images_)throw std::logic_error("LocateAnything is not loaded");
    if(image.size()!=3U*224*448)throw std::invalid_argument("Invalid LocateAnything RGB tensor shape");
    for(float value:image)if(!std::isfinite(value)||value < -1.00001f||value > 1.00001f)
      throw std::invalid_argument("Invalid LocateAnything normalized RGB value");
    if(cancelled_&&cancelled_())throw std::runtime_error("LocateAnything request cancelled");
    ainvr::BpuImageResult result;result.image_backend="gles-pillow9-rgb8";
    const auto infer=std::chrono::steady_clock::now();
    const auto response=client_->Generate(image,query_,ModelConfig().max_new_tokens,cancelled_);
    result.inference_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-infer).count();
    const auto& ids=response.at("generated_ids");const auto& logs=response.at("token_logprobs");
    if(!ids.is_array() || !logs.is_array() || ids.size()!=logs.size() || ids.size()>512)
      throw std::runtime_error("LocateAnything executor returned invalid generation arrays");
    result.outputs.resize(4);
    for(size_t i=0;i<ids.size();++i){
      result.outputs[0].push_back(ids[i].get<float>());
      result.outputs[1].push_back(logs[i].is_null()?0.0f:logs[i].get<float>());
      result.outputs[2].push_back(logs[i].is_null()?0.0f:1.0f);
    }
    // 1 finished;2 stopped at the token limit (finished boxes are kept);0 failed.
    const bool limit=response.value("stopped_at_token_limit",false);
    result.outputs[3].push_back(response.at("terminal").get<bool>()?1.0f:limit?2.0f:0.0f);
    // Several categories:one configured slot (-1 unmatched) per generated <ref> group.
    if(ModelConfig().prompts.size()>1){
      result.outputs.emplace_back();
      for(int slot:LocateAnythingRefSlots(response,ModelConfig().prompts,limit))result.outputs[4].push_back(float(slot));
    }
    return result;
  }
  std::future<ainvr::BpuImageResult> RunFrameAsync(const ainvr::Nv12Frame& frame,
      const pipeline::PreprocessConfig& p,bool bt709,bool full_range) override {
    // Remains synchronous on the GLES owner thread even for an explicit caller.
    std::promise<ainvr::BpuImageResult> promise;
    try {promise.set_value(RunFrame(frame,p,bt709,full_range));}
    catch(...) {promise.set_exception(std::current_exception());}
    return promise.get_future();
  }
  std::vector<Detection> PostprocessMulti(const std::vector<std::vector<float>>& values,
      const pipeline::ScaleInfo& scale,double,double,int maximum) override {
    complete_=false;unmatched_=0;truncated_=false;
    points_=nlohmann::json::array();
    const auto& cfg=ModelConfig();
    // One slot keeps the single-description path:its row is the whole query.
    const bool multi=cfg.prompts.size()>1;
    const config::PromptLabel only=cfg.prompts.size()==1?cfg.prompts[0]:config::PromptLabel{cfg.description,cfg.label_id,cfg.label_name};
    if(values.size()!=(multi?5u:4u) || values[0].size()!=values[1].size() || values[0].size()!=values[2].size() ||
       values[3].size()!=1 || (values[3][0]!=0 && values[3][0]!=1 && values[3][0]!=2))
      throw std::invalid_argument("LocateAnything generation output shape mismatch");
    nlohmann::json ids=nlohmann::json::array(),scores=nlohmann::json::array();
    for(size_t i=0;i<values[0].size();++i){
      const float token=values[0][i],known=values[2][i];
      if(!std::isfinite(token) || token<0 || token>=152681 || std::floor(token)!=token ||
         (known!=0 && known!=1))throw std::invalid_argument("LocateAnything generation token is invalid");
      ids.push_back(int(token));scores.push_back(known? nlohmann::json(values[1][i]):nlohmann::json(nullptr));
    }
    std::vector<int> slots;
    if(multi)for(const float slot:values[4]){
      if(!std::isfinite(slot) || std::floor(slot)!=slot)throw std::invalid_argument("LocateAnything category slot is invalid");
      slots.push_back(int(slot));
    }
    auto parsed=DecodeLocateAnythingGeometry({{"generated_ids",ids},{"token_logprobs",scores},
        {"terminal",values[3][0]==1}},scale.orig_w,scale.orig_h,only.description,only.label_id,only.label_name,maximum,
        multi?&cfg.prompts:nullptr,multi?&slots:nullptr,truncated_=values[3][0]==2);
    points_=std::move(parsed.points);unmatched_=parsed.unmatched;
    if(unmatched_)log::Warning("locateanything","已忽略 "+std::to_string(unmatched_)+
        " 个目标：模型给出的类别名与任何识别标签都不一致（建议使用简洁英文描述）");
    for(auto& point:points_){point["x"]=point["x"].get<double>()/scale.orig_w;point["y"]=point["y"].get<double>()/scale.orig_h;}
    complete_=!truncated_;
    return parsed.detections;
  }
  nlohmann::json ResultMetadata() const override {
    return {{"label_catalog",RuntimeLabelCatalog(ModelConfig(),{})},{"grounding",{{"complete",complete_},{"generation_mode",mode_},{"points",points_},
       {"coordinate_space","normalized_full_frame"},{"image_profile",{224,448}},
       {"image_resample","pillow9-bicubic-rgb8"},
       {"neural_provider","bpu"},{"neural_cpu_fallback",false},
       {"queried_categories",ModelConfig().prompts.empty()?1:ModelConfig().prompts.size()},
       {"unmatched_category_boxes",unmatched_},{"stopped_at_token_limit",truncated_}}}};
  }
 private:
  static bool CompleteLayout(const nlohmann::json& manifest) {
    const int count=manifest.value("component_count",0);
    const auto architecture=manifest.value("architecture",std::string());
    return count==213 ||
        (count==76 && architecture=="original36_qwen_moonvit27_shared_programs") ||
        (count==113 && architecture=="original36_official_four_groups") ||
        ((count==113 || count==117) && architecture=="original36_compact_affine_four_groups");
  }
  // Reverse member destruction releases images/client before channel ownership.
  std::unique_ptr<ainvr::LocateAnythingChannelLease> lease_;
  std::unique_ptr<ainvr::LocateAnythingExecutorClient> client_;
  std::unique_ptr<ainvr::LocateAnythingPillowPreprocessor> images_;
  std::function<bool()> cancelled_;
  nlohmann::json points_=nlohmann::json::array();
  std::string mode_="slow";
  std::string query_;
  size_t unmatched_=0;
  bool truncated_=false;
  bool complete_=false;
};
}  // namespace ai_service::adapters

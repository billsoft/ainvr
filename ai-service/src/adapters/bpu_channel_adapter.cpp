// Copyright AINVR. Model semantics must accompany a compiled HBM; no CPU fallback.
#include "bpu_channel_adapter.hpp"
#include "runtime_label_catalog.hpp"
#include "platform/bpu_image_input.hpp"
#include <unistd.h>
#include <openssl/evp.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <cmath>
#include <limits>
#include <set>
namespace ai_service::adapters {
namespace {
std::string Digest(const std::filesystem::path& path){
  std::ifstream file(path,std::ios::binary);if(!file)throw std::runtime_error("无法读取 BPU 模型");
  auto ctx=std::unique_ptr<EVP_MD_CTX,decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(),EVP_MD_CTX_free);
  if(!ctx||EVP_DigestInit_ex(ctx.get(),EVP_sha256(),nullptr)!=1)throw std::runtime_error("Model digest initialization failed");
  std::vector<char> block(1024*1024);
  while(file){file.read(block.data(),block.size());if(file.gcount()&&EVP_DigestUpdate(ctx.get(),block.data(),file.gcount())!=1)throw std::runtime_error("Model digest failed");}
  if(!file.eof())throw std::runtime_error("Model read failed");
  unsigned char bytes[EVP_MAX_MD_SIZE];unsigned int size=0;
  if(EVP_DigestFinal_ex(ctx.get(),bytes,&size)!=1)throw std::runtime_error("Model digest failed");
  std::ostringstream out;out<<std::hex<<std::setfill('0');for(unsigned int i=0;i<size;++i)out<<std::setw(2)<<int(bytes[i]);return out.str();
}
std::vector<std::string> RuntimePrompts(const config::ModelConfig& cfg) {
  auto phrases=cfg.class_names.value_or(std::vector<std::string>{});
  if(!cfg.prompts.empty()){phrases.clear();for(const auto& row:cfg.prompts)phrases.push_back(row.description);}
  if(phrases.empty()&&!cfg.description.empty())phrases.push_back(cfg.description);
  if(phrases.empty()||phrases.size()>32)throw std::runtime_error("开放词汇需要 1 到 32 个识别描述");
  for(const auto& phrase:phrases)if(phrase.empty()||phrase.size()>4096||phrase.find_first_not_of(" \r\n\t")==std::string::npos)
    throw std::runtime_error("识别描述为空或过长");
  return phrases;
}
std::string ResourcePath(const config::ModelConfig& cfg,const nlohmann::json& text,const char* key) {
  std::filesystem::path path=text.at(key).get<std::string>();
  if(path.empty())throw std::runtime_error("开放词汇组件路径为空");
  if(path.is_relative())path=std::filesystem::path(cfg.path).parent_path()/path;
  // Python locates pyvenv.cfg relative to the executable entry point. Resolving
  // the venv symlink to /usr/bin/python drops its isolated tokenizer packages.
  if(std::string(key)=="tokenizer_python")return std::filesystem::absolute(path).lexically_normal().string();
  return std::filesystem::weakly_canonical(path).string();
}
ainvr::BpuPromptResources PromptResources(const config::ModelConfig& cfg,const nlohmann::json& text) {
  return {ResourcePath(cfg,text,"text_hbm"),ResourcePath(cfg,text,"reprta_hbm"),
          ResourcePath(cfg,text,"tokenizer_python"),ResourcePath(cfg,text,"tokenizer_helper"),
          ResourcePath(cfg,text,"tokenizer_assets")};
}
void ValidateDynamicText(const config::ModelConfig& cfg,const nlohmann::json& manifest) {
  RuntimePrompts(cfg);
  const auto& text=manifest.at("dynamic_text");const auto resources=PromptResources(cfg,text);
  const int slots=text.at("prompt_slots").get<int>();
  if((slots!=8&&slots!=32)||RuntimePrompts(cfg).size()>size_t(slots)||text.at("embedding_size")!=512||text.at("neural_backend")!="bpu")
    throw std::runtime_error("开放词汇组件接口与 S100P 不一致");
  const auto& validation=manifest.at("validation");
  if(manifest.value("production_approved",false)!=true||validation.value("full_pipeline_accuracy_verified",false)!=true||
      validation.value("independent_images",0)<128||validation.value("runtime_free_text_verified",false)!=true)
    throw std::runtime_error("开放词汇模型尚未通过完整独立图片和自由文字验证");
  const auto& metrics=validation.at("metrics");
  for(const char* key:{"agreement_precision","agreement_recall","mean_matched_iou"}) {
    const double value=metrics.at(key).get<double>();
    if(!std::isfinite(value)||value<0||value>1)throw std::runtime_error("开放词汇质量指标无效");
  }
  if(metrics.at("agreement_precision").get<double>()<.95||metrics.at("agreement_recall").get<double>()<.95||
      metrics.at("mean_matched_iou").get<double>()<.9)
    throw std::runtime_error("开放词汇模型识别质量未达到验收门槛");
  for(const auto& [path,key]:std::vector<std::pair<std::string,std::string>>{
      {resources.text_hbm,"text_hbm_sha256"},{resources.reprta_hbm,"reprta_hbm_sha256"},
      {resources.tokenizer_helper,"tokenizer_helper_sha256"},
      {(std::filesystem::path(resources.tokenizer_assets)/"simple_tokenizer.py").string(),"tokenizer_source_sha256"},
      {(std::filesystem::path(resources.tokenizer_assets)/"bpe_simple_vocab_16e6.txt.gz").string(),"tokenizer_bpe_sha256"}}) {
    if(!std::filesystem::is_regular_file(path)||Digest(path)!=text.at(key))
      throw std::runtime_error("开放词汇组件文件与校验契约不一致");
  }
  if(!std::filesystem::is_regular_file(resources.tokenizer_python)||access(resources.tokenizer_python.c_str(),X_OK)!=0)
    throw std::runtime_error("尚未安装文字分词运行环境");
  ainvr::BpuPromptEngine::ValidatePhrases(resources,RuntimePrompts(cfg));
}
std::pair<int64_t,int64_t> OutputMatrix(const nlohmann::json& output){
  const auto& dimensions=output.at("shape");
  if(!dimensions.is_array())throw std::runtime_error("BPU 输出形状必须为整数数组");
  std::vector<int64_t> shape;
  for(const auto& dimension:dimensions){
    if(!dimension.is_number_integer())throw std::runtime_error("BPU 输出形状必须为正整数");
    if(dimension.is_number_unsigned()&&dimension.get<uint64_t>()>uint64_t(std::numeric_limits<int64_t>::max()))
      throw std::runtime_error("BPU 输出形状超出整数范围");
    const auto value=dimension.get<int64_t>();
    if(value<=0)throw std::runtime_error("BPU 输出形状必须为正整数");
    shape.push_back(value);
  }
  if(shape.size()==3&&shape.front()==1)shape.erase(shape.begin());
  if(shape.size()!=2||shape[0]>std::numeric_limits<int64_t>::max()/shape[1])
    throw std::runtime_error("BPU 输出需要固定的单批次矩阵");
  return {shape[0],shape[1]};
}
void ValidateOutputSignatures(const config::ModelConfig& cfg,const nlohmann::json& outputs,int prompt_slots=8){
  std::set<std::string> names;
  std::set<std::pair<int64_t,int64_t>> expected,actual;
  const bool scrfd=cfg.adapter=="scrfd_bpu";
  const bool yoloe=cfg.adapter=="yoloe_bpu";
  if(scrfd){
    if(cfg.input_size[0]%32||cfg.input_size[1]%32)
      throw std::runtime_error("SCRFD BPU 输入尺寸必须为 32 的倍数");
    for(int stride:{8,16,32})for(int columns:{1,4,10}){
      const int64_t count=int64_t(cfg.input_size[0]/stride)*(cfg.input_size[1]/stride)*2;
      expected.emplace(count,columns);
    }
  }
  for(const auto& output:outputs){
    if(!output.at("name").is_string())throw std::runtime_error("BPU 输出名称必须为字符串");
    const auto name=output.at("name").get<std::string>();
    if(name.empty()||!names.insert(name).second)throw std::runtime_error("BPU 输出名称为空或重复");
    const auto matrix=OutputMatrix(output);
    if(scrfd){
      if(!actual.insert(matrix).second)throw std::runtime_error("SCRFD BPU 输出头形状重复");
    }else if(yoloe){
      if(cfg.input_size!=std::vector<int>{640,640}||matrix!=std::pair<int64_t,int64_t>{4+prompt_slots,8400}||name!="boxes_scores")
        throw std::runtime_error("YOLOE BPU 输出必须匹配 640 输入、对应词槽的原始检测头");
    }else if(matrix.second!=6){
      throw std::runtime_error("YOLO BPU 输出必须为 [N,6] 或 [1,N,6] 的端到端矩阵");
    }
  }
  if(scrfd&&actual!=expected)throw std::runtime_error("SCRFD BPU 输出头与输入尺寸、步长或关键点布局不一致");
}
}
BpuChannelAdapter::BpuChannelAdapter(config::ModelConfig cfg):config_(std::move(cfg)){
  if(config_.adapter!="yoloe_bpu")ApplyTaskTypeHint(config_.class_names.value_or(std::vector<std::string>{}),config_.name,config_.path);
}
std::string BpuChannelAdapter::ModelFileDigest(const std::string& path){return Digest(path);}
nlohmann::json BpuChannelAdapter::ValidateModel(const config::ModelConfig& cfg){
  if(cfg.input_size.size()!=2||cfg.input_size[0]<=0||cfg.input_size[1]<=0)
    throw std::runtime_error("Invalid model input dimensions");
  if(cfg.provider!="bpu"||std::filesystem::path(cfg.path).extension()!=".hbm")
    throw std::runtime_error("生产识别要求 BPU 的 .hbm 模型；不使用 CPU 或 Jetson 模型");
  const bool yoloe=cfg.adapter=="yoloe_bpu";
  if(cfg.adapter!="yolo26_bpu"&&cfg.adapter!="yoloface_bpu"&&cfg.adapter!="scrfd_bpu"&&!yoloe)
    throw std::runtime_error("该模型的 S100P BPU 任务适配尚未完成");
  if(!std::filesystem::is_regular_file(cfg.path))throw std::runtime_error("尚未安装编译后的 BPU 模型");
  const auto metadata=cfg.path+".ainvr.json";
  if(!std::filesystem::is_regular_file(metadata)||std::filesystem::file_size(metadata)>1024*1024)
    throw std::runtime_error("缺少有效的 BPU 模型编译契约 (.hbm.ainvr.json)");
  std::ifstream file(metadata);auto m=nlohmann::json::parse(file);
  if(m.at("schema_version")!=1||m.at("target")!="rdk_s100p"||m.at("adapter")!=cfg.adapter)
    throw std::runtime_error("BPU 模型契约与设备或任务不一致");
  if(m.at("hbm_sha256")!=Digest(cfg.path))throw std::runtime_error("BPU 模型与编译契约校验不一致");
  if(m.at("input_size").get<std::vector<int>>()!=cfg.input_size)
    throw std::runtime_error("BPU 模型输入尺寸与通道配置不一致");
  const auto input=m.at("input_contract").get<std::string>();
  if(yoloe?input!="float_nchw_dynamic_prompts":(input!="float_nchw"&&input!="nv12_full_range_bt601_embedded"))throw std::runtime_error("不支持的 BPU 图像输入契约");
  const auto output=m.at("output_contract").get<std::string>();
  if(output!=(yoloe?"raw_xywh_class_probabilities":(cfg.adapter=="scrfd_bpu"?"scrfd_9_heads":"end2end_xyxy_score_class")))
    throw std::runtime_error("BPU 模型输出布局与任务不一致");
  if(yoloe)ValidateDynamicText(cfg,m);
  else {
    auto names=m.at("class_names").get<std::vector<std::string>>();
    if(names.empty()||(cfg.class_names&&*cfg.class_names!=names))throw std::runtime_error("BPU 模型类别表与通道配置不一致");
  }
  if(!m.at("outputs").is_array()||m.at("outputs").size()!=(cfg.adapter=="scrfd_bpu"?9:1))
    throw std::runtime_error("BPU 模型输出数量与任务不一致");
  // Same layouts accepted by the reused decoders; reject incompatible compiled
  // artifacts before SDK allocation, source opening, or operator-stop changes.
  ValidateOutputSignatures(cfg,m.at("outputs"),yoloe?m.at("dynamic_text").at("prompt_slots").get<int>():8);
  const auto& pre=m.at("preprocess");
  pre.at("rgb_order").get<bool>();pre.at("normalize").get<bool>();
  const auto mean=pre.at("mean").get<std::array<double,3>>();
  const auto divisor=pre.at("std").get<std::array<double,3>>();
  for(int i=0;i<3;++i)if(!std::isfinite(mean[i])||!std::isfinite(divisor[i])||divisor[i]<=0)
    throw std::runtime_error("Invalid compiled normalization contract");
  return m;
}
void BpuChannelAdapter::Load(const std::string& path,const std::string& provider,const std::string&){
  if(path!=config_.path||provider!=config_.provider)throw std::runtime_error("Model load does not match its configuration");
  manifest_=ValidateModel(config_);
  const bool yoloe=config_.adapter=="yoloe_bpu";
  if(yoloe) {
    prompt_names_=RuntimePrompts(config_);
    ainvr::BpuPromptEngine encoder(PromptResources(config_,manifest_.at("dynamic_text")));
    prompt_values_=encoder.Encode(prompt_names_,manifest_.at("dynamic_text").at("prompt_slots").get<size_t>());
  }
  const bool nv12=manifest_["input_contract"]=="nv12_full_range_bt601_embedded";
  runner_=std::make_unique<ainvr::BpuImageRunner>(path,nv12?ainvr::BpuImageContract::Nv12EmbeddedPreprocess:ainvr::BpuImageContract::FloatNchw,yoloe?"images":"");
  description_=runner_->Description();
  const auto h=config_.input_size.at(0),w=config_.input_size.at(1);
  const auto index=yoloe?ainvr::BpuFloatImageInputIndex(description_.at("inputs"),"images"):0;
  const auto input=description_.at("inputs").at(index).at("shape").get<std::vector<int>>();
  if(input!=(nv12?std::vector<int>{1,h,w,1}:std::vector<int>{1,3,h,w}))throw std::runtime_error("HBM input shape differs from compilation contract");
  if(yoloe) {
    const auto& inputs=description_.at("inputs");if(inputs.size()!=2)throw std::runtime_error("YOLOE requires image and prompt inputs");
    const auto& prompt=inputs.at(1-index);
    if(prompt.at("name")!="prompt_embeddings"||prompt.at("shape")!=nlohmann::json::array({1,manifest_.at("dynamic_text").at("prompt_slots").get<int>(),512})||prompt.at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||prompt.at("quantization")!=NONE)
      throw std::runtime_error("YOLOE prompt SDK signature mismatch");
  }
  const auto& expected=manifest_.at("outputs");const auto& actual=description_.at("outputs");
  if(expected.size()!=actual.size())throw std::runtime_error("HBM output count differs from compilation contract");
  for(size_t i=0;i<actual.size();++i)
    if(expected[i].at("name")!=actual[i].at("name")||expected[i].at("shape")!=actual[i].at("shape"))
      throw std::runtime_error("HBM output signature differs from compilation contract");
}
std::pair<int,int> BpuChannelAdapter::InputSize() const{return {config_.input_size.at(0),config_.input_size.at(1)};}
pipeline::PreprocessConfig BpuChannelAdapter::DefaultPreprocess() const{
  if(manifest_.is_null())throw std::logic_error("Model has not been loaded on inference thread");
  auto p=pipeline::PreprocessConfig{};const auto& m=manifest_.at("preprocess");
  p.normalize=m.at("normalize");p.rgb_order=m.at("rgb_order");
  p.mean=m.at("mean").get<std::array<double,3>>();p.std=m.at("std").get<std::array<double,3>>();return p;
}
nlohmann::json BpuChannelAdapter::ResultMetadata() const{
  nlohmann::json result={{"execution_backend","s100p_bpu"},{"input_contract",manifest_.at("input_contract")},
          {"output_contract",manifest_.at("output_contract")},{"hbm_sha256",manifest_.at("hbm_sha256")}};
  if(config_.adapter=="yoloe_bpu") {
    const auto& text=manifest_.at("dynamic_text");
    result.update({{"prompt_phrases",prompt_names_},{"text_hbm_sha256",text.at("text_hbm_sha256")},
      {"reprta_hbm_sha256",text.at("reprta_hbm_sha256")},{"text_execution_backend","s100p_bpu"},
      {"prompt_slots",text.at("prompt_slots")},{"active_prompts",prompt_names_.size()}});
  }
  const auto names=config_.adapter=="yoloe_bpu"?prompt_names_:
      config_.adapter=="scrfd_bpu"?std::vector<std::string>{"face"}:
      manifest_.at("class_names").get<std::vector<std::string>>();
  result["label_catalog"]=RuntimeLabelCatalog(config_,names);
  return result;
}
ainvr::BpuImageResult BpuChannelAdapter::RunFrame(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& p,bool bt709,bool full_range){
  return RunFrameAsync(frame,p,bt709,full_range).get();
}
std::future<ainvr::BpuImageResult> BpuChannelAdapter::RunFrameAsync(const ainvr::Nv12Frame& frame,const pipeline::PreprocessConfig& p,bool bt709,bool full_range){
  if(!runner_)throw std::logic_error("BPU model has not been loaded");
  if(p.interpolation!="bilinear"&&p.interpolation!="nearest"&&p.interpolation!="bicubic"&&p.interpolation!="area"&&p.interpolation!="lanczos4")throw std::runtime_error("未知模型预处理插值方式");
  if(!p.letterbox)throw std::runtime_error("该任务当前要求 letterbox 预处理以保持原坐标还原契约");
  ainvr::ImageTransform t;auto [h,w]=InputSize();t.height=h;t.width=w;t.letterbox=p.letterbox;
  t.nearest=p.interpolation=="nearest";t.bgr=!p.rgb_order;t.yuv_bt709=bt709;t.yuv_full_range=full_range;
  if(p.interpolation=="bicubic")t.interpolation=ainvr::ImageInterpolation::Bicubic;
  else if(p.interpolation=="area")t.interpolation=ainvr::ImageInterpolation::Area;
  else if(p.interpolation=="lanczos4")t.interpolation=ainvr::ImageInterpolation::Lanczos4;
  for(int i=0;i<3;++i){t.padding[i]=p.padding_color[i];t.mean[i]=p.normalize?p.mean[i]:0;t.divisor[i]=p.normalize?p.std[i]:1;}
  if(manifest_["input_contract"]=="nv12_full_range_bt601_embedded"){
    const auto expected=DefaultPreprocess();
    if(p.normalize!=expected.normalize||p.mean!=expected.mean||p.std!=expected.std||p.rgb_order!=expected.rgb_order)
      throw std::runtime_error("嵌入预处理的 BPU 模型不允许重复或改变归一化");
    t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  }
  if(config_.adapter=="yoloe_bpu")return runner_->RunAsync(frame,t,{{"prompt_embeddings",prompt_values_}});
  return runner_->RunAsync(frame,t);
}
std::vector<Detection> BpuChannelAdapter::Postprocess(const std::vector<float>& values,const pipeline::ScaleInfo& scale,double c,double i,int max){
  const auto& o=description_.at("outputs").at(0);
  const ainvr::DenseTensor tensor{o.at("name"),o.at("shape").get<std::vector<int64_t>>(),values};
  auto detections=config_.adapter=="yoloe_bpu"?ainvr::DecodeYoloeRaw(tensor,scale,prompt_names_,{c,i,max}):
      ainvr::DecodeEndToEnd(tensor,scale,manifest_.at("class_names").get<std::vector<std::string>>(),{c,i,max});
  if(config_.adapter=="yoloe_bpu")for(auto& d:detections) {
    d.query_description=prompt_names_.at(size_t(d.class_id));
    if(!config_.prompts.empty()) {
      const auto& label=config_.prompts.at(size_t(d.class_id));
      d.label_id=label.label_id;d.class_name=label.label_name;continue;
    }
    d.label_id=config_.label_id;
    if(prompt_names_.size()>1&&!d.label_id.empty())d.label_id+=":"+std::to_string(d.class_id);
    if(prompt_names_.size()==1&&!config_.label_name.empty())d.class_name=config_.label_name;
  }
  if(SquareSnapshotCrop())for(auto& d:detections){const double side=std::max(d.bbox[2],d.bbox[3]);
    d.bbox[0]+=(d.bbox[2]-side)/2;d.bbox[1]+=(d.bbox[3]-side)/2;d.bbox[2]=d.bbox[3]=side;}
  return detections;
}
std::vector<Detection> BpuChannelAdapter::PostprocessMulti(const std::vector<std::vector<float>>& values,const pipeline::ScaleInfo& scale,double c,double i,int max){
  const auto& outputs=description_.at("outputs");if(outputs.size()!=values.size())throw std::runtime_error("Incomplete BPU outputs");
  std::vector<ainvr::DenseTensor> tensors;
  for(size_t k=0;k<values.size();++k)tensors.push_back({outputs[k].at("name"),outputs[k].at("shape").get<std::vector<int64_t>>(),values[k]});
  return ainvr::DecodeScrfd(tensors,scale,{c,i,max});
}
}

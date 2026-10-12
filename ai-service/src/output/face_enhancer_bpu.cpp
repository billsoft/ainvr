// Copyright AINVR. No CPU inference or CPU image math in restoration.
#include "face_enhancer_bpu.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/face_restore_gles.hpp"
#include <array>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <openssl/evp.h>
namespace ai_service::output {
namespace {
int ModelSize(const std::string& model){
  if(model=="gpen")return 256;
  if(model=="codeformer")return 512;
  throw std::invalid_argument("Unknown BPU face restoration task");
}
std::string Digest(const std::filesystem::path& path){
  std::ifstream file(path,std::ios::binary);
  auto ctx=std::unique_ptr<EVP_MD_CTX,decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(),EVP_MD_CTX_free);
  if(!file||!ctx||EVP_DigestInit_ex(ctx.get(),EVP_sha256(),nullptr)!=1)
    throw std::runtime_error("Cannot hash BPU face model");
  std::array<char,65536> block;
  while(file){file.read(block.data(),block.size());
    if(file.gcount()&&EVP_DigestUpdate(ctx.get(),block.data(),file.gcount())!=1)
      throw std::runtime_error("BPU face model hash failed");}
  if(!file.eof())throw std::runtime_error("BPU face model read failed");
  unsigned char bytes[EVP_MAX_MD_SIZE];unsigned int count=0;
  if(EVP_DigestFinal_ex(ctx.get(),bytes,&count)!=1)throw std::runtime_error("BPU face model hash failed");
  std::ostringstream out;out<<std::hex<<std::setfill('0');
  for(unsigned i=0;i<count;++i)out<<std::setw(2)<<int(bytes[i]);return out.str();
}
void ValidateDescriptor(const nlohmann::json& d,int size){
  if(d.at("shape")!=nlohmann::json::array({1,3,size,size})||
     d.at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||d.at("quantization")!=NONE)
    throw std::runtime_error("BPU restoration requires fixed float32 RGB NCHW I/O");
}
class BpuFaceEnhancer final : public FaceEnhancer {
 public:
  BpuFaceEnhancer(std::string model,std::string path)
    :name_(std::move(model)),path_(std::move(path)),size_(ModelSize(name_)){}
  void EnsureLoaded() override {
    std::lock_guard lock(mutex_);if(model_)return;
    auto contract=ValidateFaceEnhanceBpuManifest(name_,path_);
    auto model=std::make_unique<ainvr::BpuModel>(path_);
    auto description=model->Describe();
    if(description.at("inputs").size()!=1||description.at("outputs").size()!=1)
      throw std::runtime_error("Export restoration with one image input and one image output");
    for(const char* kind:{"inputs","outputs"}){
      ValidateDescriptor(description[kind][0],size_);
      if(description[kind][0].at("name")!=contract[kind][0].at("name")||
         description[kind][0].at("shape")!=contract[kind][0].at("shape"))
        throw std::runtime_error("HBM restoration signature differs from its compilation contract");
    }
    description_=std::move(description);model_=std::move(model);
  }
  cv::Mat EnhanceRgba(const cv::Mat& input,double blend) override {
    EnsureLoaded();
    // Mali preparation/readback is per worker thread. BpuModel::Run serializes
    // its shared SDK buffers through completion and copies outputs before unlock.
    // This lets independent GLES stages overlap the single BPU inference stage.
    const auto& description=description_;
    auto prepared=ainvr::PrepareFaceRestoreGles(input,size_);
    auto bytes=ainvr::PackBpuFloatNchw(prepared.nchw,description["inputs"][0]);
    auto output=model_->Run({bytes});
    return ainvr::FinishFaceRestoreGles(prepared,output.at(0),description["outputs"][0],blend);
  }
 private:
  std::string name_,path_;int size_;
  std::mutex mutex_;
  std::unique_ptr<ainvr::BpuModel> model_;
  nlohmann::json description_;
};
}
nlohmann::json ValidateFaceEnhanceBpuManifest(const std::string& model,
                                            const std::filesystem::path& path){
  const int size=ModelSize(model);
  if(path.extension()!=".hbm")throw std::runtime_error("Face enhancement requires a compiled BPU .hbm model");
  if(!std::filesystem::is_regular_file(path))throw std::runtime_error("Compiled BPU face model is not installed");
  const auto manifest=path.string()+".ainvr.json";
  if(!std::filesystem::is_regular_file(manifest)||std::filesystem::file_size(manifest)>1024*1024)
    throw std::runtime_error("Face model requires its HBM compilation contract");
  std::ifstream file(manifest);auto m=nlohmann::json::parse(file);
  if(m.at("schema_version")!=1||m.at("target")!="rdk_s100p"||
     m.at("adapter")!=model+"_bpu"||m.at("role")!="face_restoration"||
     m.at("input_size")!=nlohmann::json::array({size,size})||
     m.at("input_contract")!="float_nchw_rgb_minus1_1_cubic_gray128"||
     m.at("output_contract")!="float_nchw_rgb_minus1_1")
    throw std::runtime_error("Face restoration compilation contract mismatch");
  if(!m.at("inputs").is_array()||m["inputs"].size()!=1||
     !m.at("outputs").is_array()||m["outputs"].size()!=1)
    throw std::runtime_error("Face restoration contract must specify exactly one image input/output");
  for(const char* kind:{"inputs","outputs"}){
    if(m[kind][0].at("shape")!=nlohmann::json::array({1,3,size,size})||
       m[kind][0].at("name").get<std::string>().empty())
      throw std::runtime_error("Invalid restoration tensor signature");
  }
  if(m.at("hbm_sha256")!=Digest(path))throw std::runtime_error("Face HBM hash differs from its compilation contract");
  return m;
}
std::shared_ptr<FaceEnhancer> CreateFaceEnhancerBpu(const std::string& model,const std::string& path){
  return std::make_shared<BpuFaceEnhancer>(model,path);
}
void RegisterFaceEnhancerBpu(const std::filesystem::path& root){
  struct Registry {
    std::mutex mutex;
    std::unordered_map<std::string,std::pair<std::string,std::shared_ptr<FaceEnhancer>>> current;
  };
  // Preserve the reference's process-lifetime registry, avoiding SDK teardown
  // order during global destruction. At most one current entry per task.
  auto owned=std::make_unique<Registry>();
  auto registry=owned.get();
  RegisterFaceEnhancerFactory([registry,root](const std::string& model,const std::string& raw){
    auto path=std::filesystem::path(raw);if(path.is_relative())path=root/path;
    const auto key=path.lexically_normal().string();
    std::lock_guard lock(registry->mutex);
    auto& entry=registry->current[model];
    if(!entry.second||entry.first!=key)entry={key,CreateFaceEnhancerBpu(model,key)};
    return entry.second;
  });
  owned.release();
}
}

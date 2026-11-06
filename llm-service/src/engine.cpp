#include "request.hpp"
#include "focus_task.hpp"
#include "engine.hpp"
#include <openssl/sha.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

namespace ainvr::llm {
namespace {
nlohmann::json ReadJson(const std::string& path) { std::ifstream f(path); nlohmann::json j; f>>j; return j; }
std::string ReadText(const std::string& path) { std::ifstream f(path); if(!f)throw std::runtime_error("cannot open "+path); return {std::istreambuf_iterator<char>(f),{}}; }
std::string Hash(const std::string& path) {
  std::ifstream f(path,std::ios::binary); if(!f)throw std::runtime_error("cannot hash "+path);
  SHA256_CTX context; SHA256_Init(&context); std::array<char,65536> block;
  while(f) { f.read(block.data(),block.size()); SHA256_Update(&context,block.data(),f.gcount()); }
  if(!f.eof()) throw std::runtime_error("package read error");
  unsigned char hash[32]; SHA256_Final(hash,&context); std::ostringstream out;
  for(auto b:hash) out<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b);
  return out.str();
}
std::string SafePath(const std::string& root,const std::string& relative) {
  std::filesystem::path rel(relative);
  if(rel.is_absolute()||relative.empty())throw std::runtime_error("invalid package path");
  for(auto& part:rel) if(part=="..")throw std::runtime_error("package path traversal");
  auto base=std::filesystem::canonical(root).string()+"/";
  auto path=std::filesystem::canonical(std::filesystem::path(root)/rel).string();
  if(path.rfind(base,0)!=0)throw std::runtime_error("package symlink escapes root");
  return path;
}
void Replace(std::string& value,const std::string& key,const std::string& replacement) {
  auto pos=value.find(key); if(pos==std::string::npos)throw std::runtime_error("template placeholder missing");
  value.replace(pos,key.size(),replacement);
}
}
std::vector<float> ReadFloats(const std::string& path) {
  auto size=std::filesystem::file_size(path);
  if(size%4)throw std::runtime_error("invalid float table");
  std::vector<float> out(size/4); std::ifstream f(path,std::ios::binary);
  f.read(reinterpret_cast<char*>(out.data()),size); if(!f)throw std::runtime_error("short float table"); return out;
}
Engine::Engine(const std::string& root):root_(root),manifest_(ReadJson(root+"/llm-package.ainvr.json")) {
  if(manifest_.at("schema")!="ainvr.llm_package.v1"||manifest_.at("adapter")!="qwen3vl_grouped")throw std::runtime_error("unsupported package");
  shape_=ModelShape::FromManifest(manifest_);
  // The GPU preprocessing and the compiled vision programs are fixed to this geometry; refuse anything else loudly.
  const auto& image=manifest_.at("image");
  if(image.at("width")!=896||image.at("height")!=448||image.at("tokens")!=shape_.image_tokens||shape_.image_tokens!=392||shape_.image_grid_w!=28)
    throw std::runtime_error("unsupported image geometry");
  package_sha256_=Hash(root+"/llm-package.ainvr.json");
  for(auto& f:manifest_.at("files")) {
    auto path=SafePath(root_,f.at("path"));
    if(std::filesystem::file_size(path)!=f.at("bytes").get<size_t>()||Hash(path)!=f.at("sha256"))
      throw std::runtime_error("package verification failed: "+f.at("path").get<std::string>());
  }
  template_=ReadJson(root+"/task-template.json");
  tokenizer_=tokenizers::Tokenizer::FromBlobJSON(ReadText(root+"/tokenizer.json"));
  vcos_=ReadFloats(root+"/vision_cos.f32"); vsin_=ReadFloats(root+"/vision_sin.f32");
  cos_=ReadFloats(root+"/rope_cos.f32"); sin_=ReadFloats(root+"/rope_sin.f32");
  const size_t rope=size_t(shape_.context)*shape_.rope_pairs();
  if(vcos_.size()!=1568*64||vsin_.size()!=1568*64||cos_.size()!=rope||sin_.size()!=rope)
    throw std::runtime_error("rotary table shape mismatch");
  auto path=SafePath(root,manifest_.at("embedding").at("path"));
  embedding_bytes_=std::filesystem::file_size(path);
  auto shape=manifest_.at("embedding").at("shape").get<std::vector<size_t>>();
  if(shape.size()!=2||shape[1]!=size_t(shape_.hidden)||shape[0]*shape[1]*2!=embedding_bytes_)throw std::runtime_error("embedding shape");
  int fd=open(path.c_str(),O_RDONLY|O_CLOEXEC); if(fd<0)throw std::runtime_error("open embedding");
  embedding_=mmap(nullptr,embedding_bytes_,PROT_READ,MAP_PRIVATE,fd,0); close(fd);
  if(embedding_==MAP_FAILED){embedding_=nullptr;throw std::runtime_error("mmap embedding");}
}
Engine::~Engine(){if(embedding_)munmap(embedding_,embedding_bytes_);}
std::vector<int> Engine::Encode(const std::string& kind,const std::string& description) {
  if(kind.empty()||description.empty()||kind.size()>1024||description.size()>8192)throw std::invalid_argument("invalid alarm text");
  // Reject special-token injection into the fixed, validated task template.
  if(kind.find("<|")!=std::string::npos||description.find("<|")!=std::string::npos)
    throw std::invalid_argument("reserved template delimiter");
  std::string prompt=template_.at("prompt"); Replace(prompt,"{desc}",description); Replace(prompt,"{kind}",kind);
  std::string text=template_.at("prefix");
  for(int i=0;i<shape_.image_tokens;++i)text+=template_.at("image_token").get<std::string>();
  std::string suffix=template_.at("suffix"); Replace(suffix,"{prompt}",prompt); text+=suffix;
  auto ids=tokenizer_->Encode(text);
  if(int(ids.size())>shape_.context)throw InputError("input_too_long","Complete image and text input exceeds "+std::to_string(shape_.context)+" tokens");
  Positions(ids,shape_); return ids;
}
std::vector<int> Engine::EncodeSearch(const SearchRequest& request) {
  (void)SearchDecisionIndices(manifest_.at("decision_vocabulary"));
  return EncodeSearchInput(request, [&](const auto& prompt) { return tokenizer_->Encode(prompt); }, shape_);
}
std::vector<int> Engine::EncodeFocus(const nlohmann::json& context) {
  auto ids=tokenizer_->Encode(FocusInput(shape_,context));
  if(int(ids.size())>shape_.context)throw InputError("input_too_long","Focus task exceeds model token capacity");
  Positions(ids,shape_);return ids;
}
void Engine::Load() {
  if(head_)return;
  auto make=[&](const nlohmann::json& p){return std::make_unique<BpuProgram>(SafePath(root_,p.at("file")),p.at("profiles"),root_,pool_);};
  try {
    for(auto& p:manifest_.at("programs").at("vision"))vision_.push_back(make(p));
    for(auto& p:manifest_.at("programs").at("text"))text_.push_back(make(p));
    head_=make(manifest_.at("programs").at("head").at(0));
    if(vision_.empty()||text_.size()!=shape_.group_layers.size())throw std::runtime_error("program group count");
  }catch(...){head_.reset();text_.clear();vision_.clear();pool_.clear();throw;}
}
std::vector<float> Engine::Infer(const std::vector<int>& ids,const std::vector<float>& patches,
                                const std::function<void()>& before_submit) {
  if(!head_)throw std::runtime_error("model not loaded");
  const int H=shape_.hidden,D=shape_.head_dim,K=shape_.kv_heads,C=shape_.context;
  auto positions=Positions(ids,shape_); const int length=ids.size(); auto plan=PrefillPlan(length,shape_);
  if(patches.size()!=1568*1536)throw std::invalid_argument("patch tensor shape");
  for(int id:ids)if(id<0||size_t(id)>=embedding_bytes_/(size_t(H)*2))throw std::invalid_argument("token outside vocabulary");
  auto h=patches; std::vector<std::vector<float>> deep;
  for(auto& v:vision_) { auto out=v->Run("s1",{h,vcos_,vsin_},before_submit); h=std::move(out[0]); if(out.size()>1)deep.push_back(std::move(out[1])); }
  if(h.size()!=size_t(shape_.image_tokens)*H||int(deep.size())!=shape_.deepstack)throw std::runtime_error("vision output shape");
  std::vector<float> hidden(size_t(length)*H); int image_row=0;
  auto* embedding=static_cast<const uint16_t*>(embedding_);
  std::vector<std::vector<float>> ds(shape_.deepstack,std::vector<float>(size_t(length)*H));
  for(int row=0;row<length;++row) {
    if(ids[row]==shape_.image_token_id) {
      std::copy_n(h.data()+size_t(image_row)*H,H,hidden.data()+size_t(row)*H);
      for(int j=0;j<shape_.deepstack;++j)std::copy_n(deep[j].data()+size_t(image_row)*H,H,ds[j].data()+size_t(row)*H);
      ++image_row;
    }else for(int col=0;col<H;++col) {
      uint32_t bits=uint32_t(embedding[size_t(ids[row])*H+col])<<16;
      std::memcpy(hidden.data()+size_t(row)*H+col,&bits,4);
    }
  }
  for(size_t group=0;group<text_.size();++group) {
    const int tensors=2*shape_.group_layers[group];   // one K and one V cache per decoder layer of this group
    std::vector<std::vector<float>> cache(tensors,std::vector<float>(size_t(K)*C*D));
    std::vector<float> next(hidden.size());
    for(auto c:plan) {
      std::vector<std::vector<float>> inputs;
      inputs.emplace_back(size_t(c.profile)*H,0.f); std::copy_n(hidden.data()+size_t(c.start)*H,size_t(c.rows)*H,inputs[0].data());
      inputs.emplace_back(c.profile*D); inputs.emplace_back(c.profile*D);
      FillRope(positions,c,cos_.data(),sin_.data(),inputs[1].data(),inputs[2].data(),shape_);
      inputs.emplace_back(c.profile*C); FillMask(c,inputs[3].data(),shape_);
      if(group==0)for(int j=0;j<shape_.deepstack;++j) { inputs.emplace_back(size_t(c.profile)*H,0.f); std::copy_n(ds[j].data()+size_t(c.start)*H,size_t(c.rows)*H,inputs.back().data()); }
      for(auto& kv:cache)inputs.push_back(kv);
      auto out=text_[group]->Run("s"+std::to_string(c.profile),inputs,before_submit);
      std::copy_n(out[0].data(),size_t(c.rows)*H,next.data()+size_t(c.start)*H);
      for(int i=0;i<tensors;++i)for(int head=0;head<K;++head) {
        auto* base=cache[i].data()+size_t(head)*C*D;
        std::memmove(base+size_t(C-c.start-c.rows)*D,base+size_t(C-c.start)*D,size_t(c.start)*D*4);
        std::copy_n(out[1+i].data()+size_t(head)*c.profile*D,size_t(c.rows)*D,base+size_t(C-c.rows)*D);
      }
    }
    hidden=std::move(next);
  }
  return head_->Run("s1",{std::vector<float>(hidden.end()-H,hidden.end())},before_submit).at(0);
}
} // namespace ainvr::llm

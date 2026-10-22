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
  if(manifest_.at("schema")!="ainvr.llm_package.v1"||manifest_.at("adapter")!="qwen3vl_grouped"||
     manifest_.at("context_tokens")!=1024||manifest_.at("prefill")!=256)throw std::runtime_error("unsupported package");
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
  if(vcos_.size()!=1568*64||vsin_.size()!=1568*64||cos_.size()!=1024*64||sin_.size()!=1024*64)
    throw std::runtime_error("rotary table shape mismatch");
  auto path=SafePath(root,manifest_.at("embedding").at("path"));
  embedding_bytes_=std::filesystem::file_size(path);
  auto shape=manifest_.at("embedding").at("shape").get<std::vector<size_t>>();
  if(shape.size()!=2||shape[1]!=2560||shape[0]*shape[1]*2!=embedding_bytes_)throw std::runtime_error("embedding shape");
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
  for(int i=0;i<392;++i)text+=template_.at("image_token").get<std::string>();
  std::string suffix=template_.at("suffix"); Replace(suffix,"{prompt}",prompt); text+=suffix;
  auto ids=tokenizer_->Encode(text); Positions(ids); return ids;
}
void Engine::Load() {
  if(head_)return;
  auto make=[&](const nlohmann::json& p){return std::make_unique<BpuProgram>(SafePath(root_,p.at("file")),p.at("profiles"),root_,pool_);};
  try {
    for(auto& p:manifest_.at("programs").at("vision"))vision_.push_back(make(p));
    for(auto& p:manifest_.at("programs").at("text"))text_.push_back(make(p));
    head_=make(manifest_.at("programs").at("head").at(0));
    if(vision_.size()!=4||text_.size()!=4)throw std::runtime_error("program group count");
  }catch(...){head_.reset();text_.clear();vision_.clear();pool_.clear();throw;}
}
std::vector<float> Engine::Infer(const std::vector<int>& ids,const std::vector<float>& patches,
                                const std::function<void()>& before_submit) {
  if(!head_)throw std::runtime_error("model not loaded");
  auto positions=Positions(ids); const int length=ids.size(); auto plan=PrefillPlan(length);
  if(patches.size()!=1568*1536)throw std::invalid_argument("patch tensor shape");
  for(int id:ids)if(id<0||size_t(id)>=embedding_bytes_/(2560*2))throw std::invalid_argument("token outside vocabulary");
  auto h=patches; std::vector<std::vector<float>> deep;
  for(auto& v:vision_) { auto out=v->Run("s1",{h,vcos_,vsin_},before_submit); h=std::move(out[0]); if(out.size()>1)deep.push_back(std::move(out[1])); }
  if(h.size()!=392*2560||deep.size()!=3)throw std::runtime_error("vision output shape");
  std::vector<float> hidden(length*2560); int image_row=0;
  auto* embedding=static_cast<const uint16_t*>(embedding_);
  std::vector<std::vector<float>> ds(3,std::vector<float>(length*2560));
  for(int row=0;row<length;++row) {
    if(ids[row]==151655) {
      std::copy_n(h.data()+image_row*2560,2560,hidden.data()+row*2560);
      for(int j=0;j<3;++j)std::copy_n(deep[j].data()+image_row*2560,2560,ds[j].data()+row*2560);
      ++image_row;
    }else for(int col=0;col<2560;++col) {
      uint32_t bits=uint32_t(embedding[size_t(ids[row])*2560+col])<<16;
      std::memcpy(hidden.data()+row*2560+col,&bits,4);
    }
  }
  for(int group=0;group<4;++group) {
    std::vector<std::vector<float>> cache(18,std::vector<float>(8*1024*128));
    std::vector<float> next(hidden.size());
    for(auto c:plan) {
      std::vector<std::vector<float>> inputs;
      inputs.emplace_back(c.profile*2560,0.f); std::copy_n(hidden.data()+c.start*2560,c.rows*2560,inputs[0].data());
      inputs.emplace_back(c.profile*128); inputs.emplace_back(c.profile*128);
      FillRope(positions,c,cos_.data(),sin_.data(),inputs[1].data(),inputs[2].data());
      inputs.emplace_back(c.profile*1024); FillMask(c,inputs[3].data());
      if(group==0)for(int j=0;j<3;++j) { inputs.emplace_back(c.profile*2560,0.f); std::copy_n(ds[j].data()+c.start*2560,c.rows*2560,inputs.back().data()); }
      for(auto& kv:cache)inputs.push_back(kv);
      auto out=text_[group]->Run("s"+std::to_string(c.profile),inputs,before_submit);
      std::copy_n(out[0].data(),c.rows*2560,next.data()+c.start*2560);
      for(int i=0;i<18;++i)for(int head=0;head<8;++head) {
        auto* base=cache[i].data()+head*1024*128;
        std::memmove(base+(1024-c.start-c.rows)*128,base+(1024-c.start)*128,c.start*128*4);
        std::copy_n(out[1+i].data()+head*c.profile*128,c.rows*128,base+(1024-c.rows)*128);
      }
    }
    hidden=std::move(next);
  }
  return head_->Run("s1",{std::vector<float>(hidden.end()-2560,hidden.end())},before_submit).at(0);
}
} // namespace ainvr::llm

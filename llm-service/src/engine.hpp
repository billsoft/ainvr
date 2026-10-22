#pragma once
#include "bpu_program.hpp"
#include "layout.hpp"
#include <tokenizers_cpp.h>

namespace ainvr::llm {
class Engine {
 public:
  explicit Engine(const std::string& root);
  ~Engine();
  std::vector<int> Encode(const std::string& kind,const std::string& description);
  void Load();
  std::vector<float> Infer(const std::vector<int>& ids,const std::vector<float>& patches,
                           const std::function<void()>& before_submit = {});
  const std::string& package_sha256() const { return package_sha256_; }
  const nlohmann::json& manifest() const { return manifest_; }
 private:
  std::string root_,package_sha256_;
  nlohmann::json manifest_,template_;
  std::unique_ptr<tokenizers::Tokenizer> tokenizer_;
  void* embedding_=nullptr;
  size_t embedding_bytes_=0;
  BufferPool pool_;
  std::vector<std::unique_ptr<BpuProgram>> vision_,text_;
  std::unique_ptr<BpuProgram> head_;
  std::vector<float> vcos_,vsin_,cos_,sin_;
};
std::vector<float> ReadFloats(const std::string& path);
} // namespace ainvr::llm

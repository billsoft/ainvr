// Copyright AINVR. CPU handles bounded strings, indices and byte layout only.
#include "bpu_prompt_engine.hpp"
#include "bpu_image_input.hpp"
#include "tensor_decode.hpp"
#include <spawn.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <cmath>
#include <stdexcept>
#include <algorithm>

namespace ainvr {
namespace {
struct Pipe {
  int fds[2]{-1,-1};
  explicit Pipe(bool socket=false){
    const int result=socket?socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,fds):pipe2(fds,O_CLOEXEC);
    if(result!=0)throw std::runtime_error("Cannot create tokenizer IPC");
  }
  ~Pipe(){Close(0);Close(1);}
  void Close(int index){if(fds[index]>=0){close(fds[index]);fds[index]=-1;}}
};
struct Child {
  pid_t pid=-1;
  ~Child(){if(pid>0){kill(pid,SIGKILL);while(waitpid(pid,nullptr,0)<0&&errno==EINTR){}}}
};
std::vector<std::array<int32_t,77>> Tokenize(const BpuPromptResources& resource,
    const std::vector<std::string>& phrases) {
  if(phrases.empty()||phrases.size()>8)throw std::invalid_argument("开放词汇一次需要 1 到 8 个描述");
  for(const auto& phrase:phrases)if(phrase.empty()||phrase.size()>4096)
    throw std::invalid_argument("识别描述为空或过长");
  const auto request=nlohmann::json({{"phrases",phrases}}).dump();
  if(request.size()>32768)throw std::invalid_argument("文字输入过长");
  Pipe input(true),output;Child child;
  posix_spawn_file_actions_t actions;
  int rc=posix_spawn_file_actions_init(&actions);
  if(rc)throw std::runtime_error("Tokenizer spawn initialization failed");
  auto add=[&](int result){if(result&&rc==0)rc=result;};
  add(posix_spawn_file_actions_adddup2(&actions,input.fds[0],STDIN_FILENO));
  add(posix_spawn_file_actions_adddup2(&actions,output.fds[1],STDOUT_FILENO));
  // No decoder/socket/GPU descriptors leak into the string-only helper.
  add(posix_spawn_file_actions_addclosefrom_np(&actions,3));
  std::vector<std::string> words{resource.tokenizer_python,resource.tokenizer_helper,
                               "--assets",resource.tokenizer_assets};
  std::vector<char*> argv;for(auto& word:words)argv.push_back(word.data());argv.push_back(nullptr);
  std::vector<std::string> environment{"PATH=/usr/bin:/bin","LANG=C.UTF-8",
      "PYTHONNOUSERSITE=1","PYTHONDONTWRITEBYTECODE=1","PYTHONUNBUFFERED=1"};
  std::vector<char*> env;for(auto& value:environment)env.push_back(value.data());env.push_back(nullptr);
  if(rc==0)rc=posix_spawn(&child.pid,words[0].c_str(),&actions,nullptr,argv.data(),env.data());
  posix_spawn_file_actions_destroy(&actions);
  if(rc!=0)throw std::runtime_error("无法启动文字分词器: "+std::to_string(rc));
  input.Close(0);output.Close(1);
  if(fcntl(input.fds[1],F_SETFL,O_NONBLOCK)<0||fcntl(output.fds[0],F_SETFL,O_NONBLOCK)<0)
    throw std::runtime_error("Tokenizer pipe configuration failed");
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  size_t sent=0;std::string response;bool eof=false;
  while(!eof) {
    if(std::chrono::steady_clock::now()>=deadline)throw std::runtime_error("文字分词超时");
    pollfd fds[2]{{input.fds[1],POLLOUT,0},{output.fds[0],POLLIN|POLLHUP,0}};
    int result=poll(fds,2,50);
    if(result<0){if(errno==EINTR)continue;throw std::runtime_error("Tokenizer poll failed");}
    if(input.fds[1]>=0&&(fds[0].revents&(POLLOUT|POLLERR|POLLHUP))) {
      auto n=send(input.fds[1],request.data()+sent,request.size()-sent,MSG_NOSIGNAL);
      if(n>0)sent+=size_t(n);
      else if(n<0&&errno!=EAGAIN&&errno!=EINTR)throw std::runtime_error("Tokenizer input write failed");
      if(sent==request.size())input.Close(1);
    }
    if(fds[1].revents&(POLLIN|POLLHUP)) {
      char buffer[4096];ssize_t n;
      while((n=read(output.fds[0],buffer,sizeof(buffer)))>0) {
        response.append(buffer,size_t(n));
        if(response.size()>32768)throw std::runtime_error("Tokenizer response exceeds bounded protocol");
      }
      if(n==0)eof=true;
      else if(errno!=EAGAIN&&errno!=EINTR)throw std::runtime_error("Tokenizer output read failed");
    }
  }
  int status=0;
  for(;;) {
    const auto waited=waitpid(child.pid,&status,WNOHANG);
    if(waited==child.pid){child.pid=-1;break;}
    if(waited<0){if(errno==EINTR)continue;throw std::runtime_error("Tokenizer wait failed");}
    if(std::chrono::steady_clock::now()>=deadline)throw std::runtime_error("Tokenizer exit timeout");
    poll(nullptr,0,5);
  }
  if(!WIFEXITED(status)||WEXITSTATUS(status)!=0)throw std::runtime_error("识别描述无效或分词器配置错误");
  auto body=nlohmann::json::parse(response);
  if(body.at("context_length")!=77||body.at("vocab_size")!=49408||body.at("neural_inference")!=false||
      body.at("phrases")!=phrases||body.at("tokens").size()!=phrases.size())
    throw std::runtime_error("Tokenizer response contract mismatch");
  std::vector<std::array<int32_t,77>> result;
  for(const auto& row:body.at("tokens")) {
    if(!row.is_array()||row.size()!=77)throw std::runtime_error("Tokenizer must return exactly 77 indices");
    std::array<int32_t,77> tokens{};
    for(size_t i=0;i<77;++i) {
      if(!row[i].is_number_integer())throw std::runtime_error("Tokenizer index is not an integer");
      auto index=row[i].get<int64_t>();if(index<0||index>49407)throw std::runtime_error("Tokenizer index out of range");
      tokens[i]=int32_t(index);
    }
    result.push_back(tokens);
  }
  return result;
}
void Shape(const nlohmann::json& d,const std::string& name,const std::vector<int>& shape,int type) {
  if(d.at("name")!=name||d.at("shape").get<std::vector<int>>()!=shape||d.at("dtype_id")!=type||d.at("quantization")!=NONE)
    throw std::runtime_error("BPU text component tensor contract mismatch");
}
}
BpuPromptEngine::BpuPromptEngine(BpuPromptResources resources)
    :resources_(std::move(resources)),text_(resources_.text_hbm),reprta_(resources_.reprta_hbm),
     text_description_(text_.Describe()),reprta_description_(reprta_.Describe()) {
  for(const auto* d:{&text_description_,&reprta_description_})
    if(d->at("inputs").size()!=1||d->at("outputs").size()!=1)throw std::runtime_error("Unexpected text component input/output count");
  Shape(text_description_.at("inputs").at(0),"tokens",{1,77},HB_DNN_TENSOR_TYPE_S32);
  if(text_description_.at("outputs").at(0).at("shape")!=nlohmann::json::array({1,512}))
    throw std::runtime_error("Text encoder must emit one 512-dimensional vector");
  Shape(reprta_description_.at("inputs").at(0),"text_embeddings",{1,8,512},HB_DNN_TENSOR_TYPE_F32);
  if(reprta_description_.at("outputs").at(0).at("shape")!=nlohmann::json::array({1,8,512}))
    throw std::runtime_error("RepRTA must emit eight 512-dimensional vectors");
}
std::vector<float> BpuPromptEngine::Encode(const std::vector<std::string>& phrases) {
  auto rows=Tokenize(resources_,phrases);std::vector<float> embeddings(8*512,0);
  const auto& input=text_description_.at("inputs").at(0);
  const size_t bytes=input.at("aligned_bytes").get<size_t>();
  if(bytes<77*sizeof(int32_t)||bytes>4*1024*1024||input.at("byte_strides").at(1)!=4)
    throw std::runtime_error("Text token SDK layout mismatch");
  for(size_t i=0;i<rows.size();++i) {
    std::vector<unsigned char> packed(bytes,0);std::memcpy(packed.data(),rows[i].data(),77*sizeof(int32_t));
    auto outputs=text_.Run({packed});auto encoded=DecodeTensor(outputs.at(0),text_description_.at("outputs").at(0));
    if(encoded.size()!=512)throw std::runtime_error("Text embedding size mismatch");
    for(float x:encoded)if(!std::isfinite(x))throw std::runtime_error("Non-finite text embedding");
    std::copy(encoded.begin(),encoded.end(),embeddings.begin()+i*512);
  }
  auto outputs=reprta_.Run({PackBpuFloatTensor(embeddings,reprta_description_.at("inputs").at(0))});
  auto prompts=DecodeTensor(outputs.at(0),reprta_description_.at("outputs").at(0));
  if(prompts.size()!=8*512)throw std::runtime_error("Final prompt size mismatch");
  for(float x:prompts)if(!std::isfinite(x))throw std::runtime_error("Non-finite prompt embedding");
  std::fill(prompts.begin()+phrases.size()*512,prompts.end(),0.f);
  return prompts;
}
void BpuPromptEngine::ValidatePhrases(const BpuPromptResources& resources,
                                    const std::vector<std::string>& phrases) {
  Tokenize(resources,phrases);
}
}

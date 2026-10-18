// Copyright AINVR. Local complete-HBM executor protocol; no inference fallback.
#pragma once
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace ainvr {
class LocateAnythingExecutorClient {
 public:
  LocateAnythingExecutorClient(std::string socket_path,std::string contract_sha256,
                              double maximum_seconds)
      : path_(std::move(socket_path)),contract_(std::move(contract_sha256)),seconds_(maximum_seconds) {
    if(path_.empty() || path_.size()>=sizeof(sockaddr_un::sun_path) || contract_.size()!=64 ||
       !std::isfinite(seconds_) || seconds_<=0 || seconds_>3600)
      throw std::invalid_argument("Invalid LocateAnything execution contract");
    for(char c:contract_)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))
      throw std::invalid_argument("Invalid LocateAnything contract digest");
  }
  nlohmann::json Health() const { return Request({{"operation","health"}}, {}, {}, 10); }
  nlohmann::json Validate(const std::string& description,int tokens) const {
    return Request({{"operation","validate"},{"description",description},{"tokens",tokens}}, {}, {}, 10);
  }
  nlohmann::json Generate(const std::vector<float>& chw,const std::string& description,
                         int tokens,const std::function<bool()>& cancelled={}) const {
    const uint16_t endian=1;
    if(*reinterpret_cast<const uint8_t*>(&endian)!=1 || chw.size()!=3U*224*448)
      throw std::invalid_argument("LocateAnything requires little-endian RGB CHW[3,224,448]");
    for(float x:chw)if(!std::isfinite(x))throw std::invalid_argument("Non-finite LocateAnything input");
    return Request({{"operation","generate"},{"description",description},{"tokens",tokens},
       {"input_bytes",chw.size()*sizeof(float)},{"input_shape",{3,224,448}},
       {"pixel_format","rgb-chw-f32le"}},chw,cancelled,seconds_);
  }
 private:
  struct Socket {
    int fd;
    ~Socket(){if(fd>=0)::close(fd);}
    Socket(const Socket&)=delete;
    explicit Socket(int value):fd(value){}
  };
  nlohmann::json Request(nlohmann::json header,const std::vector<float>& pixels,
                       const std::function<bool()>& cancelled,double seconds) const {
    struct stat info{};
    if(::lstat(path_.c_str(),&info) || !S_ISSOCK(info.st_mode) || info.st_uid!=::getuid() || (info.st_mode&0077))
      throw std::runtime_error("LocateAnything BPU executor is unavailable or has invalid ownership");
    Socket connection(::socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0));
    if(connection.fd<0)throw std::runtime_error("Cannot create LocateAnything executor connection");
    sockaddr_un address{};address.sun_family=AF_UNIX;
    std::memcpy(address.sun_path,path_.c_str(),path_.size()+1);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::duration<double>(seconds);
    auto wait=[&](short events){
      for(;;){
        if(cancelled && cancelled())throw std::runtime_error("LocateAnything request cancelled");
        if(std::chrono::steady_clock::now()>=deadline)throw std::runtime_error("LocateAnything executor deadline exceeded");
        pollfd item{connection.fd,events,0};const int count=::poll(&item,1,100);
        if(count<0 && errno==EINTR)continue;
        if(count<0)throw std::runtime_error("LocateAnything executor polling failed");
        if(count>0)return;
      }
    };
    if(::connect(connection.fd,reinterpret_cast<sockaddr*>(&address),sizeof(address))){
      if(errno!=EINPROGRESS)throw std::runtime_error("Cannot connect to LocateAnything BPU executor");
      wait(POLLOUT);int error=0;socklen_t size=sizeof(error);
      if(::getsockopt(connection.fd,SOL_SOCKET,SO_ERROR,&error,&size)||error)
        throw std::runtime_error("LocateAnything executor connection failed");
    }
    ucred peer{};socklen_t peer_size=sizeof(peer);
    if(::getsockopt(connection.fd,SOL_SOCKET,SO_PEERCRED,&peer,&peer_size)||peer.uid!=::getuid())
      throw std::runtime_error("LocateAnything executor peer identity mismatch");
    auto transfer=[&](void* data,size_t bytes,bool sending){
      size_t done=0;
      while(done<bytes){
        wait(sending?POLLOUT:POLLIN);
        auto* ptr=static_cast<char*>(data)+done;
        const auto amount=sending?::send(connection.fd,ptr,bytes-done,MSG_NOSIGNAL):
                                     ::recv(connection.fd,ptr,bytes-done,0);
        if(amount<0 && (errno==EAGAIN||errno==EWOULDBLOCK||errno==EINTR))continue;
        if(amount<=0)throw std::runtime_error("LocateAnything executor connection ended");
        done+=size_t(amount);
      }
    };
    header["schema_version"]=1;header["contract_sha256"]=contract_;
    auto request=header.dump();
    if(request.size()>65536)throw std::invalid_argument("LocateAnything request header too large");
    uint32_t bytes=htonl(uint32_t(request.size()));
    transfer(&bytes,sizeof(bytes),true);transfer(request.data(),request.size(),true);
    if(!pixels.empty())transfer(const_cast<float*>(pixels.data()),pixels.size()*sizeof(float),true);
    transfer(&bytes,sizeof(bytes),false);bytes=ntohl(bytes);
    if(bytes==0 || bytes>1024U*1024)throw std::runtime_error("LocateAnything executor response exceeds capacity");
    std::string text(bytes,'\0');transfer(text.data(),text.size(),false);
    auto result=nlohmann::json::parse(text);
    if(!result.value("ok",false) || result.value("schema_version",0)!=1 || result.value("contract_sha256",std::string())!=contract_)
      throw std::runtime_error("LocateAnything BPU executor rejected the request or returned a different model");
    return result;
  }
  std::string path_,contract_;
  double seconds_;
};
}  // namespace ainvr

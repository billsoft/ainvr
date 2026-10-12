#include "uds_server.hpp"
#include "diagnostics.hpp"
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <poll.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <sstream>
#include <stdexcept>
namespace ainvr_license {
namespace {
using DeadlineClock=std::chrono::steady_clock;
bool Ready(int fd,short events,DeadlineClock::time_point deadline){
  auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-DeadlineClock::now()).count();
  if(ms<=0)return false;pollfd p{fd,events,0};int n;do{n=poll(&p,1,static_cast<int>(ms));}while(n<0&&errno==EINTR);return n>0&&(p.revents&events);
}
}
bool UdsServer::Start(){
  if(running_)return false;
  failed_=false;
  if(path_.size()>=sizeof(sockaddr_un{}.sun_path))return false;
  try{
    std::filesystem::create_directories(std::filesystem::path(path_).parent_path());
    struct stat st{};if(lstat(path_.c_str(),&st)==0){if(!S_ISSOCK(st.st_mode))return false;::unlink(path_.c_str());}
    listen_fd_=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);if(listen_fd_<0)return false;
    sockaddr_un addr{};addr.sun_family=AF_UNIX;std::memcpy(addr.sun_path,path_.c_str(),path_.size()+1);
    if(bind(listen_fd_,reinterpret_cast<sockaddr*>(&addr),sizeof(addr))!=0||chmod(path_.c_str(),0660)!=0||listen(listen_fd_,32)!=0)throw std::runtime_error("UDS start failed");
    running_=true;for(int i=0;i<8;++i)workers_.emplace_back(&UdsServer::AcceptLoop,this);return true;
  }catch(...){Stop();if(listen_fd_>=0){close(listen_fd_);listen_fd_=-1;}return false;}
}
void UdsServer::Stop(){
  running_=false;
  if(listen_fd_>=0)shutdown(listen_fd_,SHUT_RDWR);
  {std::lock_guard lk(mu_);for(int fd:active_)shutdown(fd,SHUT_RDWR);}
  for(auto&t:workers_)if(t.joinable())t.join();workers_.clear();
  if(listen_fd_>=0){close(listen_fd_);listen_fd_=-1;unlink(path_.c_str());}
}
void UdsServer::AcceptLoop(){
  auto last_error=DeadlineClock::time_point{};
  while(running_){
    int fd=accept_fn_?accept_fn_(listen_fd_):accept4(listen_fd_,nullptr,nullptr,SOCK_CLOEXEC|SOCK_NONBLOCK);
    if(fd<0){
      const int error=errno;
      if(!running_)return;
      if(error==EINTR)continue;
      if(DeadlineClock::now()-last_error>=std::chrono::seconds(30)) {
        LicenseDiagnostic({{"event","uds_accept_error"},{"errno",error}});
        last_error=DeadlineClock::now();
      }
      if(error==EBADF || error==EINVAL || error==ENOTSOCK){failed_=true;return;}
      // Temporary resource exhaustion must not permanently consume a worker.
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      continue;
    }
    {std::lock_guard lk(mu_);if(!running_){close(fd);return;}active_.insert(fd);}
    try{HandleConn(fd);}catch(const std::exception&){}
    {std::lock_guard lk(mu_);active_.erase(fd);close(fd);}
  }
}
void UdsServer::HandleConn(int fd)const{
  auto deadline=DeadlineClock::now()+std::chrono::seconds(5);std::string raw;size_t split=std::string::npos;
  while(split==std::string::npos){
    if(raw.size()>16384||!Ready(fd,POLLIN,deadline))return;
    char buffer[2048];auto n=recv(fd,buffer,sizeof(buffer),0);if(n<=0)return;raw.append(buffer,n);split=raw.find("\r\n\r\n");
  }
  if(split>16384)return;
  std::istringstream lines(raw.substr(0,split));WebRequest req;std::string first,version;
  std::getline(lines,first);std::istringstream start(first);start>>req.method>>req.target>>version;if(version!="HTTP/1.1"&&version!="HTTP/1.0")return;
  size_t size=0;bool has_length=false;
  for(std::string line;std::getline(lines,line);){
    auto colon=line.find(':');if(colon==std::string::npos)return;
    auto key=line.substr(0,colon),value=line.substr(colon+1);std::transform(key.begin(),key.end(),key.begin(),[](unsigned char c){return std::tolower(c);});
    auto begin=value.find_first_not_of(" \t");value=begin==std::string::npos?"":value.substr(begin);while(!value.empty()&&(value.back()=='\r'||value.back()==' '))value.pop_back();
    if(key=="transfer-encoding")return;
    if(key=="content-length"){if(has_length||value.empty()||value.find_first_not_of("0123456789")!=std::string::npos||value.size()>6)return;has_length=true;size=std::stoul(value);if(size>10000)return;}
    if(!req.headers.emplace(key,value).second)return;
  }
  req.body=raw.substr(split+4);if(req.body.size()>size)return;
  while(req.body.size()<size){
    if(!Ready(fd,POLLIN,deadline))return;char b[2048];auto n=recv(fd,b,std::min(sizeof(b),size-req.body.size()),0);if(n<=0)return;req.body.append(b,n);
  }
  auto result=app_->Dispatch(req);
  std::string response="HTTP/1.1 "+std::to_string(result.status)+" Result\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "+std::to_string(result.body.size())+"\r\n\r\n"+result.body;
  size_t sent=0;while(sent<response.size()){if(!Ready(fd,POLLOUT,deadline))return;auto n=send(fd,response.data()+sent,response.size()-sent,MSG_NOSIGNAL);if(n<=0)return;sent+=n;}
}
}

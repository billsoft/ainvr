#pragma once
#include <nlohmann/json.hpp>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <stdexcept>
namespace ainvr::llm {
// Lifetime residency lock; release only after every model/image allocation.
class Reservation {
 public:
  Reservation(std::string directory,uint64_t bytes,uint64_t headroom,uint64_t total)
      :directory_(std::move(directory)) {
    constexpr uint64_t other=1024ULL*1024*1024;
    if(!bytes||total<other||headroom>total-other||bytes>total-other-headroom)
      throw std::runtime_error("ion_budget_exceeded");
    fd_=open((directory_+"/bpu-reservation.lock").c_str(),O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
    if(fd_<0)throw std::runtime_error("reservation_lock_unavailable");
    if(flock(fd_,LOCK_EX|LOCK_NB)){close(fd_);fd_=-1;throw std::runtime_error("large_model_busy");}
    try {
      auto path=directory_+"/bpu-reservations.json";
      if(std::filesystem::exists(path)) {
        std::ifstream f(path);nlohmann::json j;f>>j;
        if(!j.at("holders").is_array())throw std::runtime_error("invalid reservation registry");
        for(auto& h:j.at("holders")) {
          auto identity=Identity(h.at("pid").get<int>());
          if(!identity.empty()&&identity==h.at("start_ticks").get<std::string>())
            throw std::runtime_error("uncoordinated_model_holder");
        }
      }
      holder_={{"service","llm-service"},{"pid",getpid()},{"start_ticks",Identity(getpid())},
        {"bytes",bytes},{"state","loading"},{"protocol",2}};
      if(holder_.at("start_ticks")=="")throw std::runtime_error("process identity unavailable");
      Write(nlohmann::json::array({holder_}));owned_=true;
    }catch(...){close(fd_);fd_=-1;throw;}
  }
  ~Reservation(){if(fd_>=0){if(owned_)try{Write(nlohmann::json::array());}catch(...){} close(fd_);}}
  Reservation(const Reservation&)=delete;
  Reservation& operator=(const Reservation&)=delete;
  void Loaded(){holder_["state"]="loaded";Write(nlohmann::json::array({holder_}));}
 private:
  static std::string Identity(int pid){
    if(pid<=0)throw std::runtime_error("invalid holder pid");
    std::ifstream f("/proc/"+std::to_string(pid)+"/stat");std::string s;std::getline(f,s);
    auto p=s.rfind(')');if(p==std::string::npos){
      if(std::filesystem::exists("/proc/"+std::to_string(pid)))throw std::runtime_error("holder identity unreadable");
      return "";
    }
    std::istringstream fields(s.substr(p+2));std::string value;
    for(int i=3;i<=22;++i)if(!(fields>>value))throw std::runtime_error("invalid process identity");return value;
  }
  void Write(const nlohmann::json& rows){auto path=directory_+"/bpu-reservations.json",tmp=path+"."+std::to_string(getpid())+".tmp";
    {std::ofstream f(tmp);f<<nlohmann::json({{"protocol",2},{"holders",rows}}).dump();f.flush();if(!f)throw std::runtime_error("reservation_write_failed");}
    std::filesystem::rename(tmp,path);
  }
  std::string directory_;nlohmann::json holder_;int fd_=-1;bool owned_=false;
};
}

#pragma once
#include <atomic>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>
#include <functional>
#include "license_http_app.hpp"
namespace ainvr_license {
class UdsServer {
 public:
  UdsServer(std::string path,const LicenseHttpApp*app,std::function<int(int)> accept_fn={}):path_(std::move(path)),app_(app),accept_fn_(std::move(accept_fn)){}
  ~UdsServer(){Stop();}
  bool Start();
  void Stop();
  bool Failed() const { return failed_.load(); }
 private:
  void AcceptLoop();
  void HandleConn(int fd)const;
  std::string path_;
  const LicenseHttpApp*app_;
  std::function<int(int)> accept_fn_;
  int listen_fd_=-1;
  std::atomic<bool>running_{false};
  std::atomic<bool>failed_{false};
  std::mutex mu_;
  std::set<int>active_;
  std::vector<std::thread>workers_;
};
}

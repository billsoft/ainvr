#include <algorithm>
#include <atomic>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <fstream>
#include <thread>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include <httplib.h>
#include "config.hpp"
#include "clock.hpp"
#include "crypto.hpp"
#include "encoding.hpp"
#include "fingerprint.hpp"
#include "license_http_app.hpp"
#include "license_manager.hpp"
#include "uds_server.hpp"
namespace {
volatile std::sig_atomic_t stop_requested=0;
void Stop(int){stop_requested=1;}
class FileLock {
 public:
  FileLock(const std::string& path,const char* error) {
    std::filesystem::create_directories(std::filesystem::path(path).parent_path());
    fd_=open((path+".lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW|O_CLOEXEC,0600);
    if(fd_<0 || flock(fd_,LOCK_EX|LOCK_NB)!=0) {
      if(fd_>=0)close(fd_);
      throw std::runtime_error(error);
    }
  }
  ~FileLock(){close(fd_);}
  FileLock(const FileLock&)=delete;
  FileLock& operator=(const FileLock&)=delete;
 private:
  int fd_=-1;
};
}
int main(int argc,char**argv){
  std::signal(SIGPIPE,SIG_IGN);std::signal(SIGTERM,Stop);std::signal(SIGINT,Stop);
  try{
    std::string config="/etc/ainvr-license/license-service.yaml";bool identity_only=false;
    for(int i=1;i<argc;++i){std::string a=argv[i];if(a=="--license-policy"){std::cout<<"mandatory-v3-ed25519\n";return 0;}else if(a=="--machine-code")identity_only=true;else if((a=="-c"||a=="--config")&&i+1<argc)config=argv[++i];else throw std::runtime_error("unknown argument");}
    ainvr_license::LinuxFingerprintProvider provider;
    auto machine=ainvr_license::BuildMachineInfo(provider,ainvr_license::HexEncode(ainvr_license::Sha256("AINVR/public-fingerprint-salt/v2")));
    if(identity_only){std::cout<<machine.code_grouped<<"\n";return 0;}
    auto cfg=ainvr_license::LoadConfig(config);
    if(!ainvr_license::CodeEquals(machine.code,cfg.expected_machine))throw std::runtime_error("provisioned identity does not match this board");
    // Scope keeps both locks until manager and replica workers have drained.
    FileLock state_lock(cfg.state_primary,"another license service owns the state");
    // A different state path must not permit a second daemon to mutate the same
    // installation. Acquire this lock before EnableV3 can write or quarantine it.
    FileLock identity_lock(cfg.installation_path,"another license service owns the installation");
    auto store=std::make_shared<ainvr_license::StateStore>(cfg.StatePaths(),cfg.device_key,machine.chip_uid,machine.code_grouped);
    std::string migration;
    if(!cfg.migration_file.empty()){
      if(std::filesystem::file_size(cfg.migration_file)>8192)throw std::runtime_error("migration ticket too large");
      std::ifstream f(cfg.migration_file);if(!f)throw std::runtime_error("migration ticket unreadable");
      std::getline(f,migration);
      // Tickets are commonly exported on Windows; getline leaves CR from CRLF.
      if(!migration.empty() && migration.back()=='\r')migration.pop_back();
    }
    store->EnableV3(cfg.installation_path,ainvr_license::ProductionVerifyKeys(),migration);
    ainvr_license::SystemClock clock;
    ainvr_license::LicenseManager manager(machine,store,&clock);manager.SetSignalKeys(cfg.signal_keys);manager.Init();
    ainvr_license::LicenseHttpApp app(&manager,cfg.admin_api_key);
    httplib::Server tcp;tcp.set_payload_max_length(10000);tcp.set_read_timeout(3,0);tcp.set_write_timeout(3,0);
    auto forward=[&](const httplib::Request&req,httplib::Response&res){
      ainvr_license::WebRequest w;w.method=req.method;w.target=req.target;w.body=req.body;
      for(const auto&[key,value]:req.headers){auto k=key;std::transform(k.begin(),k.end(),k.begin(),[](unsigned char c){return std::tolower(c);});w.headers[k]=value;}
      auto out=app.Dispatch(w);res.status=out.status;res.set_content(out.body,"application/json; charset=utf-8");
    };
    tcp.Get("/healthz",forward);tcp.Get("/api/v1/license/.*",forward);tcp.Post("/api/v1/license/(activate|preview|remove)",forward);
    if(!tcp.bind_to_port(cfg.host.c_str(),cfg.port))throw std::runtime_error("TCP bind failed");
    ainvr_license::UdsServer uds(cfg.uds_path,&app);if(!uds.Start())throw std::runtime_error("UDS bind failed");
    std::thread listener([&]{tcp.listen_after_bind();});
    while(!stop_requested&&!uds.Failed()){manager.Tick();std::this_thread::sleep_for(std::chrono::milliseconds(200));}
    tcp.stop();uds.Stop();listener.join();return uds.Failed()?1:0;
  }catch(const std::exception&e){std::cerr<<"[license] "<<e.what()<<"\n";return 1;}
}

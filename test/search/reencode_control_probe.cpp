// MANUAL bounded real-hardware API fixture. Uses the production RegisterRoutes,
// handler and affine owner. The explicit software license oracle exists ONLY
// in this test binary; no production license/configuration is read or changed.
#include "api/search_reencode_handler.hpp"
#include <httplib.h>  // Existing AI ABI, never search-service's HTTP variant.
#include <algorithm>
#include <atomic>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <set>
#include <thread>
#include <fcntl.h>
#include <pwd.h>
#include <sys/stat.h>
#include <unistd.h>
namespace fs=std::filesystem;
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
namespace {
volatile std::sig_atomic_t interrupted=0;
void Signal(int){interrupted=1;}
void Require(bool value,const char* code){if(!value)throw std::runtime_error(code);}
int64_t WallMs(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
const char* Help(){return "Manual only: ainvr_search_reencode_control_probe --run-hardware --private-config ABSFILE\n"
  "Software validation only: --validate-config ABSFILE\n"
  "Private config must be a fresh sunrise-owned 0600 regular file under repository test/results.\n"
  "Exact config: {schema_version:search-reencode-control-fixture-v1,listen_port:25442,api_token:48 lowercase hex}.\n"
  "Loopback25442 only, empty channels, test-only software license oracle, max120s; no preload or production changes.\n"
  "--help does not construct a server, hardware owner or load a model. Hardware executes only after an authenticated request.\n";}
struct PrivateConfig {std::string token;Clock::time_point deadline;};
PrivateConfig ReadPrivate(const fs::path& path){
  Require(path.is_absolute(),"probe_private_absolute_path_required");
  const auto root=fs::canonical(AINVR_SEARCH_PROBE_RESULTS_ROOT),parent=fs::canonical(path.parent_path());
  const auto relative=parent.lexically_relative(root);
  Require(!relative.empty()&&!relative.is_absolute()&&*relative.begin()!="..","probe_private_results_path_required");
  const auto* account=getpwnam("sunrise");
  Require(account&&geteuid()==account->pw_uid,"probe_sunrise_identity_required");
  struct File{int fd=-1;~File(){if(fd>=0)close(fd);}} file;
  file.fd=open(path.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
  struct stat before{},after{},name{};
  Require(file.fd>=0&&fstat(file.fd,&before)==0&&S_ISREG(before.st_mode)&&before.st_nlink==1&&
    before.st_uid==geteuid()&&(before.st_mode&0777)==0600&&before.st_size>0&&before.st_size<=4096,"probe_private_file_required");
  std::string text(size_t(before.st_size),'\0');size_t offset=0;
  while(offset<text.size()){const auto count=read(file.fd,text.data()+offset,text.size()-offset);Require(count>0,"probe_private_read_failed");offset+=size_t(count);}
  char extra=0;Require(read(file.fd,&extra,1)==0&&fstat(file.fd,&after)==0&&lstat(path.c_str(),&name)==0&&
    before.st_dev==after.st_dev&&before.st_ino==after.st_ino&&before.st_size==after.st_size&&
    before.st_mtim.tv_sec==after.st_mtim.tv_sec&&before.st_mtim.tv_nsec==after.st_mtim.tv_nsec&&
    before.st_ctim.tv_sec==after.st_ctim.tv_sec&&before.st_ctim.tv_nsec==after.st_ctim.tv_nsec&&
    name.st_dev==before.st_dev&&name.st_ino==before.st_ino,"probe_private_changed_during_read");
  const int64_t age=WallMs()-(int64_t(before.st_mtim.tv_sec)*1000+before.st_mtim.tv_nsec/1000000);
  Require(age>=-1000&&age<120000,"probe_private_expired");
  std::vector<std::set<std::string>> keys;
  const auto json=Json::parse(text,[&](int depth,Json::parse_event_t event,Json& value){
    Require(depth<=2,"probe_private_json_depth");
    if(event==Json::parse_event_t::object_start)keys.emplace_back();
    else if(event==Json::parse_event_t::key)Require(!keys.empty()&&keys.back().insert(value.get<std::string>()).second,"probe_private_duplicate_key");
    else if(event==Json::parse_event_t::object_end)keys.pop_back();
    return true;
  });
  Require(json.is_object()&&json.size()==3&&json.contains("schema_version")&&json.contains("listen_port")&&json.contains("api_token")&&
    json.at("schema_version")=="search-reencode-control-fixture-v1"&&json.at("listen_port").is_number_integer()&&
    json.at("listen_port")==25442&&json.at("api_token").is_string(),"probe_private_schema_invalid");
  const auto token=json.at("api_token").get<std::string>();
  Require(token.size()==48&&std::all_of(token.begin(),token.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}),"probe_private_key_invalid");
  return {token,Clock::now()+std::chrono::milliseconds(std::min<int64_t>(120000,120000-age))};
}
} // namespace
int main(int argc,char** argv){
  if(argc==2&&std::string(argv[1])=="--help"){std::cout<<Help();return 0;}
  try{
    const bool validate=argc==3&&std::string(argv[1])=="--validate-config";
    Require(validate||(argc==4&&std::string(argv[1])=="--run-hardware"&&std::string(argv[2])=="--private-config"),"probe_explicit_cli_required");
    const auto config=ReadPrivate(argv[validate?2:3]);
    if(validate){std::cout<<"{\"private_config_valid\":true,\"hardware_executed\":false}\n";return 0;}
    std::atomic<bool> stopping{false};std::atomic<uint64_t> maintenance_errors{0};
    const auto active=[&]{return !stopping.load()&&!interrupted&&Clock::now()<config.deadline;};
    ai_service::config::AppConfig app;app.server.host="127.0.0.1";app.server.port=25442;app.server.api_key=config.token;
    app.channels.clear();
    // No ConfigStore and no channels: no camera, history, MongoDB or production
    // configuration connection can be created by constructing this fixture.
    auto manager=std::make_shared<ai_service::api::ChannelManager>(app,nullptr,
      [](const auto&,const auto&)->std::shared_ptr<ai_service::pipeline::ChannelWorker>{throw std::runtime_error("probe_channels_forbidden");},active);
    auto hardware=ai_service::output::MakeNativeSearchHardwareOwner();
    httplib::Server server;
    server.set_payload_max_length(8*1024*1024);server.set_read_timeout(5);server.set_write_timeout(5);
    server.new_task_queue=[]{return new httplib::ThreadPool(2);};
    ai_service::api::RegisterRoutes(server,manager,[&]{return Json{{"fixture",true},{"test_only_software_license_oracle",true},
      {"production_license_bypass",false},{"channels",0},{"maintenance_errors",maintenance_errors.load()}};},
      ai_service::api::MakeSearchReencodeHandler(hardware,active,active));
    Require(server.bind_to_port("127.0.0.1",25442),"probe_loopback_bind_failed");
    std::signal(SIGTERM,Signal);std::signal(SIGINT,Signal);
    std::thread control([&]{auto next=Clock::now();while(active()){
      if(Clock::now()>=next){try{hardware->Tick();}catch(...){++maintenance_errors;}next=Clock::now()+std::chrono::milliseconds(200);}
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }stopping=true;server.stop();});
    std::cout<<Json{{"event","search_reencode_control_ready"},{"host","127.0.0.1"},{"port",25442},
      {"test_only_software_license_oracle",true},{"model_preloaded",false},{"maximum_runtime_seconds",120}}.dump()<<std::endl;
    try{server.listen_after_bind();}catch(...){stopping=true;server.stop();control.join();hardware->Stop();throw;}
    stopping=true;server.stop();control.join();manager->StopAll();hardware->Stop();
    std::cout<<Json{{"event","search_reencode_control_stopped"},{"maintenance_errors",maintenance_errors.load()}}.dump()<<std::endl;
    return 0;
  }catch(...){std::cerr<<"reencode_control_probe_failed\n";return 1;}
}

// Explicit hardware acceptance of the real service configuration/worker path.
#define main ainvr_service_entry_for_lifecycle_test
#include "../src/service.cpp"
#undef main
#include <fstream>
#include <sstream>
uint64_t IonBytes(){
  std::ifstream file("/sys/kernel/debug/ion/heaps/all_heap_info");
  std::string line;uint64_t bytes=0;
  while(std::getline(file,line)){std::istringstream in(line);std::string key;uint64_t n;if(in>>key>>n&&key=="total")bytes+=n;}
  return bytes;
}
int main(int argc,char** argv){try{
  if(argc==2&&std::string(argv[1])=="--success-state"){
    auto settings=[](bool enabled,int version,const std::string& id){
      return Json{{"enabled",enabled},{"config_version",version},{"package_id",id},{"package_root","/"+id}};
    };
    auto require=[](bool condition,const char* message){if(!condition)throw std::runtime_error(message);};
    const auto a=settings(true,1,"A");
    Service service(a,false); // Execute real transitions without a hardware worker.
    service.desired=true;service.state="loading";service.configuration.Begin(1);
    service.Apply(settings(false,2,"B"));
    service.FinishLoadSuccessLocked(a);
    require(service.state=="draining"&&service.reload_requested&&!service.Status().at("ready").get<bool>(),"stale successful load became ready");
    service.Apply(settings(true,3,"B"));
    require(service.state=="draining"&&service.reload_requested&&service.configuration.committed()!=3,"B acknowledged with A weights");
    // Model is released, and the next worker iteration loads B.
    service.ClearLoadedLocked();service.reload_requested=false;service.state="loading";
    service.FinishLoadSuccessLocked(service.config);
    require(service.state=="ready"&&service.configuration.committed()==3,"current B not acknowledged");
    service.Apply(settings(true,4,"B"));
    require(service.state=="ready"&&!service.reload_requested&&service.configuration.committed()==4,"same loaded model unnecessarily reloaded");
    // Even an inconsistent prior config cannot hide the actual engine identity.
    service.loaded_config=a;
    service.Apply(settings(true,5,"B"));
    require(service.state=="draining"&&service.reload_requested&&service.configuration.committed()!=5,"actual engine identity ignored");
    // Same package but canceled generation must not become ready either.
    Service canceled(a,false);canceled.desired=true;canceled.state="loading";
    canceled.Apply(settings(false,2,"A"));canceled.FinishLoadSuccessLocked(a);
    require(canceled.state=="draining"&&!canceled.Status().at("ready").get<bool>(),"disabled successful load published ready");
    std::cout<<"PASS actual-model identity, stale success, disable/reenable, same-model reuse; no BPU allocation\n";
    return 0;
  }
  if(argc==2&&std::string(argv[1])=="--failure-state"){
    Json old={{"enabled",true},{"config_version",2}};
    Service service({{"enabled",false},{"config_version",1}});
    {
      std::lock_guard<std::mutex> lock(service.mutex);
      service.config=old;service.configuration.Begin(2);service.state="loading";
      // No engine is started in this software fixture.
    }
    service.Apply({{"enabled",false},{"config_version",3}});
    {
      std::lock_guard<std::mutex> lock(service.mutex);
      service.FinishLoadFailureLocked(old,"injected old load failure");
      if(service.state!="unloaded"||service.desired||service.configuration.committed()!=3||
         service.configuration.Report().at("status")!="applied")
        throw std::runtime_error("disable remained pending after old load failure");
    }
    std::cout<<"PASS revoked configuration wins over old load failure; no BPU allocation\n";return 0;
  }
  if(argc!=2)throw std::runtime_error("usage: lifecycle_probe model-package-root");
  Json config={{"enabled",false},{"package_root",argv[1]},{"package_id","qwen3vl-2b-review-v1"},{"config_version",1}};
  Service service(config);service.Apply(config);
  auto wait=[&](const std::string& expected){
    const auto end=Clock::now()+std::chrono::seconds(120);
    while(Clock::now()<end){auto status=service.Status();
      if(status.at("model")==expected)return;
      if(status.at("model")=="fault")throw std::runtime_error(status.at("last_error").get<std::string>());
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("timed out: "+expected);
  };
  const auto before=IonBytes();
  config["enabled"]=true;config["config_version"]=2;service.Apply(config);wait("loading");
  config["enabled"]=false;config["config_version"]=3;service.Apply(config);wait("unloaded");
  if(service.Status().at("config_version")!=3)throw std::runtime_error("revocation not acknowledged");
  const auto after_cancel=IonBytes();
  config["enabled"]=true;config["config_version"]=4;service.Apply(config);wait("ready");
  const auto loaded=IonBytes();
  config["config_version"]=5;service.Apply(config);
  if(service.Status().at("model")!="ready"||service.Status().at("config_version")!=5)
    throw std::runtime_error("unchanged model was reloaded");
  config["enabled"]=false;config["config_version"]=6;service.Apply(config);wait("unloaded");
  const auto released=IonBytes();
  if(loaded<=released)throw std::runtime_error("ION not returned on unload");
  std::cout<<Json({{"passed",true},{"cancel_during_load",true},{"same_model_reused",true},
    {"ion_before",before},{"ion_after_cancel",after_cancel},{"ion_loaded",loaded},{"ion_after_release",released}}).dump()<<'\n';
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

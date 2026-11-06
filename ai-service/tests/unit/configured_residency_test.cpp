#include "platform/model_dependency_health.hpp"
#include "platform/configured_residency.hpp"
#include "platform/configured_models.hpp"
#include "platform/shared_runtime.hpp"
#include <cassert>
#include <atomic>
#include <future>
#include <unistd.h>

struct Resource {
  static inline std::atomic<int> alive{0};
  Resource(){++alive;}
  ~Resource(){--alive;}
};
int main(){
  ainvr::ModelDependencyHealth health;
  health.Observe({"a"});health.Observe({"a"});
  assert(health.Status()["incidents"]==1&&health.Status()["failed_checks"]==2);
  health.Observe({"b"});assert(health.Status()["incidents"]==2&&health.Status()["recoveries"]==1);
  health.Failed();health.Failed();
  assert(health.Status()["state"]=="unknown"&&health.Status()["incidents"]==3);
  assert(health.Status()["current_invalid_dependencies"]==1);
  health.Observe({});assert(health.Status()["state"]=="healthy"&&health.Status()["recoveries"]==3);
  health.Observe({"a"});assert(health.Status()["incidents"]==4);

  ainvr::ConfiguredResidency<Resource> residency;
  ainvr::SharedRuntimeCache<Resource> cache;
  residency.Update({{"model",{"channel:a","channel:b"}}});
  assert(Resource::alive==0); // declaration must be lazy
  auto task=cache.Acquire("hash",[]{return std::make_shared<Resource>();});
  residency.Observe("model",task);task.reset();
  assert(Resource::alive==1&&residency.Snapshot()[0].resident);
  residency.Update({{"model",{"channel:b"}}});assert(Resource::alive==1);
  auto active=cache.Acquire("hash",[]{return std::make_shared<Resource>();});
  residency.Update({});assert(Resource::alive==1); // running task drains
  residency.DrainRetired();active.reset();assert(Resource::alive==0);
  auto late=cache.Acquire("hash",[]{return std::make_shared<Resource>();});
  residency.Observe("model",late);late.reset();assert(Resource::alive==0);
  // A late completion after revocation must not resurrect residency.
  for(int i=0;i<100;++i){
    residency.Update({{"model",{"channel:a"}}});
    auto value=std::make_shared<Resource>();
    auto revoke=std::async(std::launch::async,[&]{residency.Update({});});
    residency.Observe("model",value);revoke.get();value.reset();residency.DrainRetired();assert(Resource::alive==0);
  }
  // SDK teardown must not block configuration; same-key acquire must wait.
  struct Slow {
    std::promise<void>* entered=nullptr;std::shared_future<void> release;
    ~Slow(){if(entered){entered->set_value();release.wait();}}
  };
  ainvr::ConfiguredResidency<Slow> delayed;ainvr::SharedRuntimeCache<Slow> single;
  std::promise<void> entered,release;auto gate=release.get_future().share();
  delayed.Update({{"slow",{"channel"}}});
  auto old=single.Acquire("slow",[&]{auto p=std::make_shared<Slow>();p->entered=&entered;p->release=gate;return p;});
  delayed.Observe("slow",old);old.reset();
  delayed.Update({});
  assert(entered.get_future().wait_for(std::chrono::seconds(2))==std::future_status::ready);
  assert(delayed.Snapshot().empty());
  std::atomic<bool> created{false};
  auto next=std::async(std::launch::async,[&]{return single.Acquire("slow",[&]{created=true;return std::make_shared<Slow>();});});
  assert(next.wait_for(std::chrono::milliseconds(30))==std::future_status::timeout);
  assert(!created);release.set_value();next.get();delayed.DrainRetired();assert(created);
  // Secondary owners (face enhancement wrappers) use the same asynchronous path.
  std::promise<void> wrapperEntered,wrapperRelease;
  auto wrapper=std::make_shared<Slow>();wrapper->entered=&wrapperEntered;
  wrapper->release=wrapperRelease.get_future().share();
  delayed.RetireResource(std::move(wrapper));
  assert(wrapperEntered.get_future().wait_for(std::chrono::seconds(2))==std::future_status::ready);
  // A different model must not cold-load while the wrapper retirement is pending.
  assert(!ainvr::SharedRetirementBarrier().WaitFor(std::chrono::milliseconds(20)));
  std::atomic<bool> coldLoaded{false};
  auto different=std::async(std::launch::async,[&]{
    ainvr::SharedRetirementBarrier().BeforeColdLoad();coldLoaded=true;
  });
  assert(different.wait_for(std::chrono::milliseconds(20))==std::future_status::timeout);
  assert(!coldLoaded);
  wrapperRelease.set_value();delayed.DrainRetired();different.get();
  assert(coldLoaded && ainvr::SharedRetirementBarrier().Pending()==0);
  ainvr::SharedRetirementBarrier().Begin();
  bool refused=false;
  try { ainvr::SharedRetirementBarrier().BeforeColdLoad(); }
  catch(const std::runtime_error&) { refused=true; }
  ainvr::SharedRetirementBarrier().End();assert(refused);

  const auto root=std::filesystem::path(std::getenv("TMPDIR")?std::getenv("TMPDIR"):"/tmp")/("ainvr-demand-"+std::to_string(getpid()));
  std::filesystem::create_directories(root);
  {std::ofstream file(root/"vision.hbm.ainvr.json");file<<R"({"dynamic_text":{"text_hbm":"text.hbm","reprta_hbm":"reprta.hbm"}})";}
  ai_service::config::AppConfig config;
  ai_service::config::ChannelConfig channel;
  channel.id="a";channel.model.path="vision.hbm";channel.model.adapter="yoloe_bpu";
  channel.snapshot.enabled=true;channel.snapshot.face_enhance_model="gpen";
  config.channels.push_back(channel);channel.id="b";config.channels.push_back(channel);
  auto demand=ainvr::CollectConfiguredModels(config,root);
  assert(demand.demand.size()==4&&demand.enhancement_paths.size()==1);
  for(const auto& [key,owners]:demand.demand)assert(owners.size()==2);
  config.channels[0].enabled=false;config.channels[1].deletion_pending=true;
  assert(ainvr::CollectConfiguredModels(config,root).demand.empty());
  config.channels[0].enabled=true;
  {std::ofstream file(root/"vision.hbm.ainvr.json");file<<"invalid";}
  const auto invalid=ainvr::CollectConfiguredModels(config,root);
  assert(invalid.invalid_dependencies==1&&invalid.demand.size()==2);
  std::filesystem::remove_all(root);
}

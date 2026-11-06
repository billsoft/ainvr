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
  active.reset();assert(Resource::alive==0);
  auto late=cache.Acquire("hash",[]{return std::make_shared<Resource>();});
  residency.Observe("model",late);late.reset();assert(Resource::alive==0);
  // A late completion after revocation must not resurrect residency.
  for(int i=0;i<100;++i){
    residency.Update({{"model",{"channel:a"}}});
    auto value=std::make_shared<Resource>();
    auto revoke=std::async(std::launch::async,[&]{residency.Update({});});
    residency.Observe("model",value);revoke.get();value.reset();assert(Resource::alive==0);
  }
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

#include "../../ai-service/src/analytics/event_worker.hpp"
#include <cassert>
#include <iostream>
int main() {
  using namespace ai_service::analytics;
  std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
  auto store=std::make_shared<EventStore>(uri,"ainvr_snapshots","test_analytics_events");
  auto other=std::make_shared<EventStore>(uri,"ainvr_snapshots","test_analytics_events");
  double now=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string channel="worker-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  auto put=[&](const std::string& suffix,const std::string& owner) {
    std::string id=channel+suffix;
    store->Put({{"event_id",id},{"channel_id",owner},{"stream_session_id",channel},
      {"rule_id","door"},{"type","line_crossing"},{"track_id","1"},{"timestamp",now},
      {"review_status","not_requested"},{"notification_status","not_requested"}});
    return id;
  };
  const auto good=put("good",channel),bad=put("bad",channel),expired=put("expired",channel);
  const auto idle=put("idle",channel),outside=put("outside",channel+"other");
  for(const auto& id:{good,bad,expired,outside})assert(store->QueueJob(id,"review"));
  assert(store->ClaimJob(expired,"review","abandoned",now-20,5));
  assert(store->ReadyJobs(channel,"review",now).size()==3);
  std::atomic<int> calls{0};
  auto handler=[&](const auto& event,const EventWorker::Context& context)->EventWorker::Outcome {
    assert(!context.Cancelled());++calls;
    if(event.at("event_id")==bad)throw std::runtime_error("fixture failure");
    return {"rejected",{{"code","fixture_only"}}};
  };
  {
    EventWorker a(store,channel,"review",handler),b(other,channel,"review",handler);
    for(int i=0;i<300&&a.Completed()+b.Completed()<3;++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    assert(a.Completed()+b.Completed()==3);assert(calls==3);
    assert(a.Failures()+b.Failures()==1);
  }
  for(const auto& event:store->List(channel)) {
    const auto id=event.at("event_id").get<std::string>();
    assert(event.at("notification_status")=="not_requested");
    if(id==idle)assert(event.at("review_status")=="not_requested");
    else if(id==bad)assert(event.at("review_status")=="failed");
    else assert(event.at("review_status")=="rejected");
  }
  assert(store->List(channel+"other")[0]["review_status"]=="pending");
  assert(store->ReadyJobs(channel,"review",now+100).empty());
  std::cout<<"asynchronous job scheduling: PASS (fixture handlers only)\n";
}

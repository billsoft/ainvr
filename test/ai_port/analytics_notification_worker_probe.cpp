#include "analytics/webhook_notifier.hpp"
#include <cassert>
#include <iostream>
int main(int argc,char**argv){
 assert(argc==2);std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
 using namespace ai_service::analytics;
 auto store=std::make_shared<EventStore>(uri,"ainvr_snapshots","test_analytics_events");
 const auto id="notify-worker-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
 const double now=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
 const nlohmann::json event={{"event_id",id},{"channel_id",id},{"stream_session_id","isolated"},
   {"rule_id","door"},{"type","line_crossing"},{"track_id","1"},{"timestamp",now},
   {"review_status","not_requested"},{"notification_status","not_requested"},
   {"notification_request",{{"enabled",true},{"require_review",false},{"endpoint",argv[1]}}}};
 store->Put(event);
 {
  EventWorker worker(store,id,"notification",[](const nlohmann::json& job,const EventWorker::Context& context){
    const auto& request=job.at("notification_request");
    return WebhookNotifier(request.at("endpoint"),request.at("require_review"))(job,context);
  },20);
  const auto end=std::chrono::steady_clock::now()+std::chrono::seconds(10);
  while(worker.Completed()==0&&std::chrono::steady_clock::now()<end)std::this_thread::sleep_for(std::chrono::milliseconds(50));
  assert(worker.Completed()==1);
  store->Put(event);std::this_thread::sleep_for(std::chrono::milliseconds(600));assert(worker.Completed()==1);
 }
 auto saved=store->List(id).at(0);assert(saved.at("notification_status")=="sent");
 assert(saved.at("notification_job").at("result").at("delivery_id")==id);
 std::cout<<"{\"passed\":true,\"scope\":\"database to worker to loopback HTTP and replay\"}\n";
}

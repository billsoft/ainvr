#include "../../ai-service/src/analytics/event_store.hpp"
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
#include <atomic>
int main() {
  using ai_service::analytics::EventStore;
  std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
  EventStore first(uri,"ainvr_snapshots","test_analytics_events");
  EventStore second(uri,"ainvr_snapshots","test_analytics_events");
  double now=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::string id="jobs-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  nlohmann::json event={{"event_id",id},{"channel_id",id},{"stream_session_id",id},
    {"rule_id","door"},{"type","line_crossing"},{"track_id","track-1"},{"timestamp",now},
    {"review_status","not_requested"},{"notification_status","not_requested"}};
  first.Put(event);
  assert(!first.ClaimJob(id,"review","early",now,10));
  assert(first.QueueJob(id,"review"));assert(!second.QueueJob(id,"review"));
  std::atomic<int> winners{0};
  std::thread a([&]{if(first.ClaimJob(id,"review","attempt-a",now,10))++winners;});
  std::thread b([&]{if(second.ClaimJob(id,"review","attempt-b",now,10))++winners;});
  a.join();b.join();assert(winners==1);
  assert(!first.List(id)[0]["review_job"].contains("token"));
  assert(!first.ClaimJob(id,"review","attempt-c",now+9,10));
  assert(second.ClaimJob(id,"review","attempt-c",now+10,10));
  auto result=nlohmann::json::object();
  assert(!first.FinishJob(id,"review","attempt-a",now+11,"approved",result));
  assert(!first.FinishJob(id,"review","attempt-b",now+11,"approved",result));
  bool invalid=false;
  try{first.FinishJob(id,"review","attempt-c",now+11,"sent",result);}
  catch(const std::invalid_argument&){invalid=true;}assert(invalid);
  assert(second.FinishJob(id,"review","attempt-c",now+11,"rejected",{{"reason","target absent"}}));
  assert(!second.FinishJob(id,"review","attempt-c",now+12,"approved",result));
  first.Put(event); // durable outbox replay cannot reset the review result
  auto page=first.List(id);assert(page.size()==1);
  assert(page[0]["review_status"]=="rejected");
  assert(page[0]["review_job"]["attempts"]==2);
  assert(page[0]["notification_status"]=="not_requested");
  assert(first.QueueJob(id,"notification"));
  assert(first.ClaimJob(id,"notification","notify-a",now+12,1));
  assert(!first.FinishJob(id,"notification","notify-a",now+13,"sent",result));
  assert(second.ClaimJob(id,"notification","notify-b",now+13,10));
  assert(second.FinishJob(id,"notification","notify-b",now+14,"sent",{{"delivery_id",id}}));
  page=first.List(id);
  assert(page[0]["review_status"]=="rejected"&&page[0]["notification_status"]=="sent");
  assert(!first.QueueJob("missing-event","review"));
  // IDs deliberately oppose time order: JSON field sorting must not reorder sort keys.
  auto older=event,newer=event;
  older["event_id"]=id+"-z";older["timestamp"]=now-2;
  newer["event_id"]=id+"-a";newer["timestamp"]=now-1;
  first.Put(older);first.Put(newer);
  auto history=first.List(id);
  assert(history.size()==3&&history[0]["event_id"]==id);
  assert(history[1]["event_id"]==id+"-a"&&history[2]["event_id"]==id+"-z");
  assert(first.QueueJob(id+"-z","review"));assert(first.QueueJob(id+"-a","review"));
  auto ready=first.ReadyJobs(id,"review",now);
  assert(ready.size()==2&&ready[0]["event_id"]==id+"-z"&&ready[1]["event_id"]==id+"-a");

}

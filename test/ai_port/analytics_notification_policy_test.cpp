#include "analytics/event_store.hpp"
#include <cassert>
#include <chrono>
#include <iostream>
int main(){
 using ai_service::analytics::EventStore;using nlohmann::json;
 std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
 EventStore store(uri,"ainvr_snapshots","test_analytics_events");
 const auto channel="notify-policy-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
 const double now=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
 auto make=[&](std::string suffix,std::string review,bool enabled=true,bool require=true){
  return json{{"event_id",channel+suffix},{"channel_id",channel},{"stream_session_id","session"},{"track_id","track"},
    {"rule_id","door"},{"type","line_crossing"},{"timestamp",now},{"review_status",review},
    {"notification_status","not_requested"},{"notification_request",{{"enabled",enabled},{"require_review",require},{"endpoint","http://127.0.0.1:9/no-send"}}}};
 };
 for(auto status:{"approved","rejected","failed","timeout","unavailable","pending","processing"})store.Put(make(status,status));
 store.Put(make("disabled","approved",false));store.Put(make("direct","not_requested",true,false));
 store.AdvanceNotifications(channel);
 auto states=[&]{json map=json::object();for(const auto& e:store.List(channel)){map[e.at("event_id").get<std::string>()]=e.at("notification_status");assert(!e.at("notification_request").contains("endpoint"));}return map;};
 auto status=states();assert(status[channel+"approved"]=="pending"&&status[channel+"direct"]=="pending");
 for(auto suffix:{"rejected","failed","timeout","unavailable"})assert(status[channel+suffix]=="suppressed");
 for(auto suffix:{"pending","processing"})assert(status[channel+suffix]=="waiting_review");
 assert(status[channel+"disabled"]=="not_requested");
 store.AdvanceNotifications(channel);assert(states()==status);
 auto jobs=store.ReadyJobs(channel,"notification",now);assert(jobs.size()==2);
 assert(jobs[0].at("notification_request").contains("endpoint"));
 assert(store.ClaimJob(channel+"pending","review","review-owner",now,60));
 assert(store.FinishJob(channel+"pending","review","review-owner",now+1,"approved",json::object()));
 store.AdvanceNotifications(channel);assert(states()[channel+"pending"]=="pending");
 assert(store.ClaimJob(channel+"approved","notification","delivery-owner",now,60));
 assert(store.FinishJob(channel+"approved","notification","delivery-owner",now+1,"sent",json::object()));
 store.Put(make("approved","approved"));store.AdvanceNotifications(channel);
 assert(states()[channel+"approved"]=="sent");
 std::cout<<"notification eligibility, suppression, promotion, redaction and replay: PASS\n";
}

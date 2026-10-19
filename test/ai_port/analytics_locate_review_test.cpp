#include "analytics/locate_review.hpp"
#include <cassert>
#include <iostream>
int main() {
  using namespace ai_service;
  std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
  auto store=std::make_shared<analytics::EventStore>(uri,"ainvr_snapshots","test_analytics_events");
  config::ModelConfig cfg;cfg.name="locateanything-3b";cfg.adapter="locateanything_bpu";
  cfg.description="a person";cfg.input_size={224,448};
  analytics::LocateReview review(store,cfg);
  std::atomic<bool> stop{true};
  analytics::EventWorker::Context ctx{std::chrono::steady_clock::now()+std::chrono::seconds(30),stop};
  assert(review(nlohmann::json::object(),ctx).status=="timeout");
  stop=false;
  auto event=nlohmann::json{{"event_id","review-missing"},{"channel_id","review-missing"},
    {"track_id","1"},{"stream_session_id","test"},{"frame_pts_ns","123"}};
  auto outcome=review(event,ctx);
  assert(outcome.status=="unavailable"&&outcome.details.at("code")=="original_evidence_missing");
  // Exercise the real asynchronous handler, not only a fixture callback.
  const auto id="review-async-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  event["event_id"]=id;event["channel_id"]=id;event["rule_id"]="door";event["type"]="line_crossing";
  event["timestamp"]=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  event["review_status"]="not_requested";event["notification_status"]="not_requested";
  store->Put(event);assert(store->QueueJob(id,"review"));
  {
    analytics::EventWorker worker(store,id,"review",review,20);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(16);
    while(worker.Completed()==0&&std::chrono::steady_clock::now()<deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    assert(worker.Completed()==1);
  }
  const auto saved=store->List(id).at(0);
  assert(saved.at("review_status")=="unavailable");
  assert(saved.at("notification_status")=="not_requested");
  bool invalid=false;cfg.description="";
  try{analytics::LocateReview wrong(store,cfg);}catch(const std::invalid_argument&){invalid=true;}
  assert(invalid);
  adapters::LocateAnythingBpuAdapter adapter(cfg);
  pipeline::ScaleInfo scale{};scale.orig_w=640;scale.orig_h=480;
  adapter.PostprocessMulti({{151668,152177,151927,151669,151645},{0,0,0,0,0},{0,0,0,0,0},{1}},scale,0,0,300);
  assert(adapter.ResultMetadata()["grounding"]["complete"]==true);
  invalid=false;try{adapter.RunPreparedRgb({});}catch(const std::logic_error&){invalid=true;}
  assert(invalid&&adapter.ResultMetadata()["grounding"]["complete"]==false);
  assert(adapter.ResultMetadata()["grounding"]["points"].empty());
  std::cout<<"review cancellation, missing evidence and stale-result invalidation passed; no neural call\n";
}

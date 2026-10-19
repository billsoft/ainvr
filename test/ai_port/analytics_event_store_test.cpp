#include "../../ai-service/src/analytics/event_store.hpp"
#include <cassert>
#include <cstdlib>
#include <chrono>
int main() {
  using ai_service::analytics::EventStore;
  // Explicit isolated namespace, no production history touched.
  const char* uri=std::getenv("AINVR_TEST_MONGO_URI");
  assert(uri);
  EventStore store(uri,"ainvr_snapshots","test_analytics_events");
  std::string id="test-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  nlohmann::json event={{"event_id",id},{"channel_id",id},{"stream_session_id",id},
    {"rule_id","door"},{"type","line_crossing"},{"track_id","track-1"},{"timestamp",std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count()},
    {"review_status","pending"}};
  store.Put(event);store.Put(event);
  auto page=store.List(id);assert(page.size()==1);
  // Retry must not overwrite downstream review state / original event payload.
  event["review_status"]="not_requested";store.Put(event);
  page=store.List(id);assert(page.size()==1 && page[0]["review_status"]=="pending");
  bool invalid=false;try {store.List(id,201);}catch(const std::invalid_argument&){invalid=true;}
  assert(invalid);
}

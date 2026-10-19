// Copyright AINVR. Phase-1 product gate:tracking runs, later-stage features stay inert.
#include "../../ai-service/src/analytics/frame_analytics.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service;
static FrameResult Frame(int64_t pts,double x) {
  FrameResult f;f.channel_id="phase";f.frame_width=1000;f.frame_height=1000;f.frame_pts_ns=pts;f.timestamp=100;
  Detection d;d.bbox={x,400,50,100};d.label_id="person";d.class_name="person";d.confidence_known=false;
  f.detections.push_back(d);return f;
}
int main() {
  analytics::Config stored;stored.enabled=true;stored.save_events=true;stored.retention_days=7;
  stored.options.confirmation_hits=1;stored.options.association_distance=.3;
  stored.options.rules={{"gate","line","person",{{.5,.2},{.5,.8}},5}};
  stored.review.enabled=true;stored.review.description="a person";stored.review.model_path="m.hbm";
  stored.notification.enabled=true;stored.notification.endpoint="http://127.0.0.1:9/hook";
  // 1. Effective runtime config keeps tracking only;the stored config is untouched.
  const auto effective=analytics::PhaseEffective(stored);
  assert(effective.enabled && !effective.save_events && effective.options.rules.empty());
  assert(!effective.review.enabled && !effective.notification.enabled);
  assert(effective.options.confirmation_hits==1 && effective.options.association_distance==.3);
  assert(stored.options.rules.size()==1 && stored.review.enabled && stored.notification.enabled && stored.save_events);
  assert(!analytics::PhaseEffective(analytics::Config{}).enabled);
  // 2. With the stored line rule, a crossing target keeps its identity and trail but emits no event.
  analytics::FrameAnalytics gated(effective);
  auto a=Frame(0,400);gated.Apply(a,1,1);
  auto b=Frame(1000000000,600);gated.Apply(b,1,1);
  assert(!a.detections[0].track_id.empty() && a.detections[0].track_id==b.detections[0].track_id);
  const auto& data=b.model_extra["analytics"];
  assert(!data.contains("events") || data["events"].empty());
  assert(data["tracks"].size()==1);
  // 3. API:newly enabling a later-stage feature is refused;keeping stored values is not.
  const nlohmann::json none=nlohmann::json::object();
  const auto saved=analytics::ToJson(stored);
  assert(analytics::PhaseUnavailableRequest({{"enabled",true}},none).empty());
  assert(analytics::PhaseUnavailableRequest({{"enabled",false}},saved).empty());
  assert(analytics::PhaseUnavailableRequest(saved,saved).empty());
  assert(analytics::PhaseUnavailableRequest({{"enabled",true},{"review",{{"enabled",true}}}},none)=="review");
  assert(analytics::PhaseUnavailableRequest({{"enabled",true},{"notification",{{"enabled",true},{"endpoint","http://x"}}}},none)=="notification");
  assert(analytics::PhaseUnavailableRequest({{"enabled",true},{"rules",saved["rules"]}},none)=="rules");
  auto changed=saved;changed["rules"][0]["id"]="other";
  assert(analytics::PhaseUnavailableRequest(changed,saved)=="rules");
  auto removed=saved;removed["rules"]=nlohmann::json::array();removed["review"]["enabled"]=false;
  assert(analytics::PhaseUnavailableRequest(removed,saved).empty());
  // 4. /health reports exactly these switches.
  const auto caps=analytics::PhaseCapabilities();
  assert(caps["target_tracking"]==true && caps["analytics_rules_events"]==false);
  assert(caps["target_presence_review"]==false && caps["analytics_notifications"]==false);
  std::cout<<"{\"status\":\"completed\",\"suite\":\"analytics_phase\"}\n";
}

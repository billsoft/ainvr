#include "../../ai-service/src/analytics/candidate_results.hpp"
#include "../../ai-service/src/analytics/event_evidence.hpp"
#include "../../ai-service/src/output/archive_result_codec.hpp"
// Copyright AINVR. Public results and source-time lifecycle integration.
#include "../../ai-service/src/analytics/frame_analytics.hpp"
#include "../../ai-service/src/stream/sei.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service;
FrameResult Frame(int64_t pts,double x) {
  FrameResult f;f.channel_id="test";f.frame_width=1000;f.frame_height=1000;
  f.frame_pts_ns=pts;f.timestamp=100;
  Detection d;d.bbox={x,400,50,100};d.label_id="person";d.class_name="person";
  d.confidence_known=false;f.detections.push_back(d);
  return f;
}
int main() {
  analytics::Config c;
  analytics::FrameAnalytics disabled(c);
  auto old=Frame(0,400);
  auto original=old.ToDict();
  disabled.Apply(old,1,1);
  assert(old.ToDict()==original);
  c.enabled=true;c.options.confirmation_hits=1;c.options.association_distance=.3;
  c.options.rules={{"gate","line","person",{{.5,.2},{.5,.8}},5}};
  analytics::FrameAnalytics enabled(c);
  auto a=Frame(0,400);enabled.Apply(a,1,1);
  assert(!a.detections[0].track_id.empty());
  auto b=Frame(1000000000,600);enabled.Apply(b,1,1);
  assert(a.detections[0].track_id==b.detections[0].track_id);
  assert(b.model_extra["analytics"]["events"].size()==1);
  auto& event=b.model_extra["analytics"]["events"][0];
  assert(event["source_frame"]["pts_ns"]=="1000000000");
  assert(event["rule_snapshot"]["id"]=="gate");
  assert(event["target"]["bbox"][0]==600);
  assert(event["target"]["confidence"].is_null());
  analytics::LinkEventArchive(b,true);analytics::LinkEventArchive(b,true);
  assert(b.detections[0].model_extra["analytics_event_ids"].size()==1);
  assert(event["evidence"]["status"]=="awaiting_archive");
  const auto replay=ainvr::DecodeArchiveResult(ainvr::EncodeArchiveResult(b));
  assert(replay.detections[0].model_extra["analytics_event_ids"][0]==event["event_id"]);
  assert(replay.detections[0].model_extra["tracking_session_id"]==event["stream_session_id"]);
  auto no_archive=b;analytics::LinkEventArchive(no_archive,false);
  assert(no_archive.model_extra["analytics"]["events"][0]["evidence"]["status"]=="archive_disabled");
  auto no_visible=b;no_visible.detections.clear();analytics::LinkEventArchive(no_visible,true);
  assert(no_visible.model_extra["analytics"]["events"][0]["evidence"]["status"]=="no_visible_target");
  auto wrong_frame=b;wrong_frame.frame_pts_ns++;analytics::LinkEventArchive(wrong_frame,true);
  assert(wrong_frame.model_extra["analytics"]["events"][0]["evidence"]["status"]=="frame_mismatch");
  assert(b.ToDict()["detections"][0]["confidence"].is_null());
  assert(b.ToDict()["detections"][0]["track_id"]==b.detections[0].track_id);
  auto payload=sei::build_result_payload("test",b.frame_pts_ns,0,b.detections,1024,b.model_extra);
  assert(payload.size()<=1024);
  auto json=nlohmann::json::parse(std::string(payload.begin(),payload.end()));
  assert(json["det"][0]["t"]==b.detections[0].track_id);
  // Source nanoseconds must survive beyond double's exact integer range.
  analytics::FrameAnalytics provenance(c);
  constexpr int64_t long_pts=9007199254740993LL;
  auto observed=Frame(long_pts,400);provenance.Apply(observed,1,1);
  assert(observed.model_extra["analytics"]["tracks"][0]["last_observed_pts_ns"]==std::to_string(long_pts));
  auto occluded=Frame(long_pts+500000000,400);occluded.detections.clear();
  provenance.Apply(occluded,1,1);
  const auto& retained=occluded.model_extra["analytics"]["tracks"][0];
  assert(retained["observation"]=="lost");
  assert(retained["geometry_source"]=="last_observation");
  assert(retained["last_observed_pts_ns"]==std::to_string(long_pts));
  assert(retained["observation_age_ms"]==500.0);
  assert(occluded.model_extra["analytics"]["events"].empty());
  auto reacquired=Frame(long_pts+1000000000,410);provenance.Apply(reacquired,1,1);
  assert(reacquired.model_extra["analytics"]["tracks"][0]["observation_age_ms"]==0.0);
  assert(reacquired.detections[0].track_id==observed.detections[0].track_id);
  auto restarted=Frame(2000000000,600);enabled.Apply(restarted,2,2);
  assert(restarted.detections[0].track_id!=b.detections[0].track_id);
  auto missing=Frame(-1,600);enabled.Apply(missing,2,2);
  assert(missing.detections[0].track_id.empty());
  assert(missing.model_extra["analytics"]["status"]=="unavailable");
  analytics::FrameAnalytics scored(c);
  auto s1=Frame(0,450);s1.detections[0].confidence_known=true;
  s1.detections[0].confidence=0.9;scored.Apply(s1,1,1);
  assert(s1.model_extra["analytics"]["algorithm"]=="bytetrack");
  assert(!s1.detections[0].track_id.empty());
  auto s2=Frame(100000000,460);s2.detections[0].confidence_known=true;
  s2.detections[0].confidence=0.2;scored.Apply(s2,1,1);
  assert(s2.detections[0].track_id==s1.detections[0].track_id);
  assert(b.model_extra["analytics"]["algorithm"]=="motion");
  auto visible=s1.detections;
  visible[0].track_id.clear();
  auto candidates=s1.detections;
  auto low_only=candidates[0];low_only.bbox[0]+=100;low_only.track_id="low-only";
  candidates.push_back(low_only);
  analytics::CopyTrackIdentities(candidates,visible);
  assert(visible.size()==1 && visible[0].track_id==s1.detections[0].track_id);
  assert(visible[0].confidence==s1.detections[0].confidence);
  std::cout<<"analytics frame/API/SEI integration: PASS\n";
}

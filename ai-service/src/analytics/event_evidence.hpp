// AINVR. Link only the triggering observed target to its same-frame archive.
#pragma once
#include <algorithm>
#include "../output/result.hpp"
namespace ai_service::analytics {
inline void LinkEventArchive(FrameResult& frame,bool archive_enabled) {
  if(!frame.model_extra.contains("analytics"))return;
  auto& analytics=frame.model_extra["analytics"];
  if(!analytics.contains("events")||!analytics["events"].is_array())return;
  for(auto& event:analytics["events"]) {
    event["evidence"]={{"status",archive_enabled?"no_visible_target":"archive_disabled"},
                       {"kind","target_crop"}};
    if(!archive_enabled)continue;
    // Guard even internal data against accidental cross-frame reuse.
    if(event.value("channel_id",std::string{})!=frame.channel_id||
       event.value("frame_pts_ns",std::string{})!=std::to_string(frame.frame_pts_ns)) {
      event["evidence"]["status"]="frame_mismatch";continue;
    }
    const auto track=event.value("track_id",std::string{});
    if(track.empty())continue;
    for(auto& detection:frame.detections) if(detection.track_id==track) {
      auto& ids=detection.model_extra["analytics_event_ids"];
      if(!ids.is_array())ids=nlohmann::json::array();
      const auto id=event.at("event_id");
      if(std::find(ids.begin(),ids.end(),id)==ids.end())ids.push_back(id);
      detection.model_extra["tracking_session_id"]=event.at("stream_session_id");
      // A link is not proof of capture. Archive sampling/capacity can skip it.
      event["evidence"]["status"]="awaiting_archive";
      break;
    }
  }
}
}

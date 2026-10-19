// Copyright AINVR. Shared post-detection analytics for every model adapter.
#pragma once
#include "config.hpp"
#include "bytetrack_adapter.hpp"
#include "../output/result.hpp"
#include <chrono>
#include <random>
namespace ai_service::analytics {
class FrameAnalytics {
 public:
  explicit FrameAnalytics(const Config& config):config_(config),tracker_(config.options),byte_tracker_(config.options.max_gap_seconds) {
    std::random_device random;
    instance_=std::to_string(std::chrono::system_clock::now().time_since_epoch().count())+
      "-"+std::to_string(random());
  }
  void Apply(FrameResult& result,int64_t epoch,int64_t generation) {
    if(!config_.enabled) return;
    if(result.frame_pts_ns<0 || result.frame_width<=0 || result.frame_height<=0) {
      result.model_extra["analytics"]={{"status","unavailable"},{"reason","missing_source_time_or_dimensions"}};
      return;
    }
    if(!result.detections.empty()) {
      bool scored=true;
      for(const auto& d:result.detections) scored=scored&&d.confidence_known;
      algorithm_=scored?"bytetrack":"motion";
    }
    const std::string key=std::to_string(epoch)+":"+std::to_string(generation)+":"+
      std::to_string(result.frame_width)+":"+std::to_string(result.frame_height)+":"+algorithm_;
    if(key!=key_) {
      key_=key;session_=result.channel_id+":"+instance_+":"+std::to_string(++reset_);
      tracker_.Reset(session_);byte_tracker_.Reset();last_pts_=-1;observed_pts_.clear();
    }
    if(result.frame_pts_ns<=last_pts_) {
      result.model_extra["analytics"]={{"status","stale"},{"algorithm",algorithm_}};
      return;
    }
    std::vector<ScoredBox> scored_boxes;
    std::vector<Observation> observations;
    std::vector<size_t> indices;
    for(size_t i=0;i<result.detections.size();++i) {
      const auto& d=result.detections[i];
      Box box{d.bbox[0]/result.frame_width,d.bbox[1]/result.frame_height,
              d.bbox[2]/result.frame_width,d.bbox[3]/result.frame_height};
      bool valid=true;
      for(double v:box) valid=valid&&std::isfinite(v);
      if(!valid||box[0]<0||box[1]<0||box[2]<=0||box[3]<=0||
         box[0]+box[2]>1.000001||box[1]+box[3]>1.000001) continue;
      indices.push_back(i);
      observations.push_back({d.label_id.empty()?"class:"+std::to_string(d.class_id):d.label_id,box});
      if(algorithm_=="bytetrack") scored_boxes.push_back({observations.back().label,
        {static_cast<float>(d.bbox[0]),static_cast<float>(d.bbox[1]),
         static_cast<float>(d.bbox[2]),static_cast<float>(d.bbox[3])},
        static_cast<float>(d.confidence)});
    }
    const double seconds=static_cast<double>(result.frame_pts_ns)/1e9;
    Update update;
    if(algorithm_=="bytetrack") {
      auto matches=byte_tracker_.Process(seconds,scored_boxes);
      std::vector<uint64_t> ids(observations.size(),0);
      for(const auto& match:matches) ids[match.observation]=match.track_id;
      update=tracker_.ProcessTracked(seconds,observations,ids);
    } else {
      update=tracker_.Process(seconds,observations);
    }
    last_pts_=result.frame_pts_ns;
    auto tracks=nlohmann::json::array(),events=nlohmann::json::array();
    for(size_t i=0;i<indices.size();++i) if(update.observation_tracks[i])
      result.detections[indices[i]].track_id=session_+":"+std::to_string(update.observation_tracks[i]);
    std::map<uint64_t,int64_t> retained_pts;
    for(const auto& t:update.tracks) {
      const int64_t observed_pts=t.observed?result.frame_pts_ns:observed_pts_.at(t.id);
      retained_pts.emplace(t.id,observed_pts);
      tracks.push_back({{"track_id",session_+":"+std::to_string(t.id)},{"label_id",t.label},
        {"geometry_source","last_observation"},
        {"last_observed_pts_ns",std::to_string(observed_pts)},
        {"observation_age_ms",static_cast<double>(result.frame_pts_ns-observed_pts)/1e6},
        {"state",t.confirmed?"confirmed":"tentative"},{"observation",t.observed?"detected":"lost"},
        {"bbox",{{"x",t.box[0]*result.frame_width},{"y",t.box[1]*result.frame_height},
          {"w",t.box[2]*result.frame_width},{"h",t.box[3]*result.frame_height}}},
        {"velocity",{{"x",t.velocity[0]*result.frame_width},{"y",t.velocity[1]*result.frame_height},
          {"unit","pixels_per_second"}}}});
    }
    observed_pts_=std::move(retained_pts);
    for(const auto& e:update.events) {
      nlohmann::json event={{"schema_version","1.0"},{"event_id",e.id},
      {"channel_id",result.channel_id},{"stream_session_id",session_},{"rule_id",e.rule_id},
      {"type",e.type},{"direction",e.direction},{"track_id",session_+":"+std::to_string(e.track_id)},
      {"frame_pts_ns",std::to_string(result.frame_pts_ns)},{"timestamp",result.timestamp},
      {"review_status","not_requested"},{"notification_status","not_requested"}};
      event["source_frame"]={{"pts_ns",std::to_string(result.frame_pts_ns)},
        {"index",result.frame_index},{"width",result.frame_width},{"height",result.frame_height},
        {"model_name",result.model_name},{"coordinate_space","source_pixels"}};
      // Freeze the triggering geometry: later edits must not rewrite history.
      for(const auto& r:config_.options.rules) if(r.id==e.rule_id) {
        event["rule_snapshot"]={{"id",r.id},{"type",r.type},{"label_id",r.label},
          {"points",r.points},{"dwell_seconds",r.dwell_seconds}};
        break;
      }
      for(const auto& d:result.detections) if(d.track_id==event["track_id"]) {
        event["target"]={{"label_id",d.label_id},{"class_id",d.class_id},
          {"class_name",d.class_name},{"bbox",d.bbox},
          {"confidence",d.confidence_known?nlohmann::json(d.confidence):nlohmann::json(nullptr)},
          {"query_description",d.query_description}};
        break;
      }
      events.push_back(std::move(event));
    }
    result.model_extra["analytics"]={{"schema_version","1.0"},{"status",update.accepted?"active":"stale"},
      {"algorithm",algorithm_},{"stream_session_id",session_},{"tracks",tracks},{"events",events}};
  }
 private:
  std::map<uint64_t,int64_t> observed_pts_;
  Config config_;
  Tracker tracker_;
  ByteTrackAdapter byte_tracker_;
  std::string algorithm_="motion";
  int64_t last_pts_=-1;
  std::string instance_,key_,session_;
  uint64_t reset_=0;
};
} // namespace ai_service::analytics

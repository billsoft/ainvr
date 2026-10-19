// AINVR adapter around pinned ByteTrack; source coordinates are pixels.
#pragma once
#include "../../third_party/bytetrack_service/include/BYTETracker.h"
#include <algorithm>
#include <cmath>
#include <set>
#include <tuple>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
namespace ai_service::analytics {
struct ScoredBox {
  std::string label;
  cv::Rect_<float> box;
  float score;
};
struct ByteTrackMatch {
  size_t observation;
  int track_id;
  cv::Rect_<float> filtered_box;
};
class ByteTrackAdapter {
 public:
  explicit ByteTrackAdapter(double max_gap_seconds=2, int nominal_fps=10)
      : gap_(max_gap_seconds), fps_(nominal_fps) {
    if(!std::isfinite(gap_) || gap_<=0 || gap_>60 || fps_<1 || fps_>120)
      throw std::invalid_argument("Invalid ByteTrack timing");
  }
  void Reset() { groups_.clear(); last_=-1; alias_.clear(); recent_.clear(); }
  std::vector<ByteTrackMatch> Process(double pts,const std::vector<ScoredBox>& boxes) {
    if(!std::isfinite(pts)||pts<0||pts<=last_)
      throw std::invalid_argument("Source time must increase");
    if(boxes.size()>1000) throw std::invalid_argument("Too many tracking candidates");
    std::map<std::string,std::vector<Object>> input;
    for(size_t i=0;i<boxes.size();++i) {
      const auto& b=boxes[i];
      if(b.label.empty() || b.label.size()>256 || !std::isfinite(b.score) ||
         b.score<0 || b.score>1 || !std::isfinite(b.box.x) ||
         !std::isfinite(b.box.y) || !std::isfinite(b.box.width) ||
         !std::isfinite(b.box.height) || b.box.width<=0 || b.box.height<=0)
        throw std::invalid_argument("Invalid scored tracking candidate");
      if(b.score<0.1f) continue;
      input[b.label].push_back({b.box,0,b.score,static_cast<int>(i)});
    }
    size_t needed=input.size();
    for(const auto& [label,g]:groups_)
      if(pts-g.seen<=gap_ && !input.count(label)) ++needed;
    if(needed>256) throw std::invalid_argument("Too many tracking labels");
    for(auto it=groups_.begin();it!=groups_.end();) {
      if(pts-it->second.seen>gap_) it=groups_.erase(it);
      else ++it;
    }
    for(const auto& [label,objects]:input) {
      auto& group=groups_[label];
      if(!group.tracker) group.tracker=std::make_unique<BYTETracker>(fps_,30);
      group.seen=pts;
    }
    std::vector<ByteTrackMatch> result;
    std::vector<std::string> labels;
    const std::vector<Object> empty;
    for(auto& [label,group]:groups_) {
      auto it=input.find(label);
      auto tracks=group.tracker->update_at(it==input.end()?empty:it->second,pts,gap_);
      for(const auto& t:tracks) {
        if(t.source_index<0 || static_cast<size_t>(t.source_index)>=boxes.size())
          throw std::logic_error("ByteTrack lost source observation identity");
        result.push_back({static_cast<size_t>(t.source_index),t.track_id,
                         {t.tlwh[0],t.tlwh[1],t.tlwh[2],t.tlwh[3]}});
        labels.push_back(label);
      }
    }
    Recover(pts,boxes,result,labels);
    last_=pts;
    return result;
  }
 private:
  struct Group { std::unique_ptr<BYTETracker> tracker; double seen=-1; };
  // Last real observation of an emitted identity, for lost-track recovery.
  struct Recent { std::string label; cv::Rect_<float> box; double pts; float vx=0,vy=0; };
  static float Cx(const cv::Rect_<float>& b){return b.x+b.width/2;}
  static float Cy(const cv::Rect_<float>& b){return b.y+b.height/2;}
  // ByteTrack associates by overlap. At low frame rates a fast target that was
  // missed for a few frames reappears with zero overlap and gets a new internal
  // ID. A new ID may continue a lost identity of the same label when its centre
  // lies within one box diagonal of that identity's motion-extrapolated centre
  // and the size is similar. Closest pairs first, one-to-one; identities seen in
  // this frame are never taken; nothing older than max_gap_seconds.
  void Recover(double pts,const std::vector<ScoredBox>& boxes,std::vector<ByteTrackMatch>& result,
               const std::vector<std::string>& labels) {
    for(auto it=recent_.begin();it!=recent_.end();)
      if(pts-it->second.pts>gap_) it=recent_.erase(it); else ++it;
    std::set<int> present;
    std::vector<size_t> fresh;
    for(size_t i=0;i<result.size();++i) {
      auto alias=alias_.find(result[i].track_id);
      // Two internal IDs may map to one identity when ByteTrack later revives the
      // original:the first keeps it, the other continues as its own identity.
      if(alias!=alias_.end() && !present.count(alias->second)) {result[i].track_id=alias->second;present.insert(alias->second);}
      else fresh.push_back(i);
    }
    std::vector<std::tuple<float,size_t,int>> pairs;
    for(size_t i:fresh) {
      const auto& now=boxes[result[i].observation].box;
      for(const auto& [id,r]:recent_) {
        if(present.count(id) || r.label!=labels[i] || r.pts>=pts) continue;
        const float area=now.width*now.height,old=r.box.width*r.box.height;
        if(area>old*2.25f || old>area*2.25f) continue;
        const float dt=static_cast<float>(pts-r.pts);
        const float dx=Cx(now)-(Cx(r.box)+r.vx*dt),dy=Cy(now)-(Cy(r.box)+r.vy*dt);
        const float diagonal=std::hypot(r.box.width,r.box.height);
        const float ratio=std::hypot(dx,dy)/diagonal;
        if(ratio<=1.0f) pairs.emplace_back(ratio,i,id);
      }
    }
    std::sort(pairs.begin(),pairs.end());
    std::set<size_t> taken;
    for(const auto& [ratio,i,id]:pairs) {
      if(taken.count(i) || present.count(id)) continue;
      alias_[result[i].track_id]=id;result[i].track_id=id;taken.insert(i);present.insert(id);
    }
    for(size_t i:fresh) if(!taken.count(i)) {
      int own=result[i].track_id;
      // A revived duplicate keeps its own internal ID (globally unique, never an alias target).
      alias_[own]=own;result[i].track_id=own;present.insert(own);
    }
    for(size_t i=0;i<result.size();++i) {
      const auto& now=boxes[result[i].observation].box;
      Recent next{labels[i],now,pts};
      auto old=recent_.find(result[i].track_id);
      if(old!=recent_.end() && pts>old->second.pts) {
        const float dt=static_cast<float>(pts-old->second.pts);
        next.vx=(Cx(now)-Cx(old->second.box))/dt;next.vy=(Cy(now)-Cy(old->second.box))/dt;
      }
      recent_[result[i].track_id]=next;
    }
    for(auto it=alias_.begin();it!=alias_.end();)
      if(!recent_.count(it->second)) it=alias_.erase(it); else ++it;
  }
  std::map<int,int> alias_;
  std::map<int,Recent> recent_;
  std::map<std::string,Group> groups_;
  double gap_,last_=-1;
  int fps_;
};
}

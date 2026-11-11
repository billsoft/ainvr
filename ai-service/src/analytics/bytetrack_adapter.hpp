// AINVR adapter around pinned ByteTrack; source coordinates are pixels.
#pragma once
#include "../../third_party/bytetrack_service/include/BYTETracker.h"
#include "assignment.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
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
  void Reset() { groups_.clear(); last_=-1; alias_.clear(); identities_.clear(); reliable_.clear(); next_id_=0; }
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
    }
    // Near-identical boxes are competing measurements, not two people. Keep
    // source indices stable, and apply the same mask to recovery below.
    std::vector<size_t> order;
    for(size_t i=0;i<boxes.size();++i) if(boxes[i].score>=0.1f) order.push_back(i);
    std::stable_sort(order.begin(),order.end(),[&](size_t a,size_t b){return boxes[a].score>boxes[b].score;});
    std::vector<bool> eligible(boxes.size(),false);
    std::vector<size_t> kept;
    for(size_t i:order) {
      bool duplicate=false;
      for(size_t j:kept) if(boxes[i].label==boxes[j].label && Iou(boxes[i].box,boxes[j].box)>=0.9f) {duplicate=true;break;}
      if(duplicate) continue;
      kept.push_back(i);eligible[i]=true;
      const auto& b=boxes[i];
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
    Identify(pts,boxes,eligible,result);
    last_=pts;
    return result;
  }
 private:
  struct Group { std::unique_ptr<BYTETracker> tracker; double seen=-1; };
  // ---- Identity layer ----------------------------------------------------
  // ByteTrack associates by overlap only: a low-score detection must overlap
  // the prediction by IoU>=0.5, and a target missed for a few frames reappears
  // with little overlap and gets a new internal ID. Public identities are this
  // layer's own (never ByteTrack's internal numbers, which ByteTrack may revive):
  // every frame, ByteTrack's new internal tracks and the detections it left
  // unmatched (scores >= 0.1) may continue a lost identity of the same label
  // when they fit its motion-predicted box. Low scores never start an identity.
  // Classes are separate channels. All limits are in seconds, not frames.
  struct Identity { std::string label; cv::Rect_<float> box; double pts=0; float vx=0,vy=0; };
  static float Cx(const cv::Rect_<float>& b){return b.x+b.width/2;}
  static float Cy(const cv::Rect_<float>& b){return b.y+b.height/2;}
  static float Iou(const cv::Rect_<float>& a,const cv::Rect_<float>& b) {
    const float w=std::max(0.f,std::min(a.x+a.width,b.x+b.width)-std::max(a.x,b.x));
    const float h=std::max(0.f,std::min(a.y+a.height,b.y+b.height)-std::max(a.y,b.y));
    const float inter=w*h,uni=a.width*a.height+b.width*b.height-inter;
    return uni>0?inter/uni:0;
  }
  // Same target: similar aspect ratio and size, and the box overlaps the
  // constant-velocity prediction (IoU>=0.3) or its centre lies within a distance
  // that grows with the time lost. Returns a cost (lower is better) or <0.
  static float Fit(const Identity& s,const cv::Rect_<float>& d,double pts) {
    const float lost=static_cast<float>(pts-s.pts);
    const cv::Rect_<float> p{s.box.x+s.vx*lost,s.box.y+s.vy*lost,s.box.width,s.box.height};
    const float aspect=(d.width/d.height)/(p.width/p.height),area=(d.width*d.height)/(p.width*p.height);
    if(aspect>1.6f || aspect<1/1.6f || area>2.5f || area<1/2.5f) return -1;
    const float iou=Iou(p,d),diagonal=std::hypot(p.width,p.height);
    const float distance=std::hypot(Cx(d)-Cx(p),Cy(d)-Cy(p))/diagonal;
    if(iou<0.3f && distance>0.6f+0.6f*std::min(lost,1.f)) return -1;
    return distance-iou+1;
  }
  void Identify(double pts,const std::vector<ScoredBox>& boxes,const std::vector<bool>& eligible,std::vector<ByteTrackMatch>& result) {
    for(auto it=identities_.begin();it!=identities_.end();)
      if(pts-it->second.pts>gap_) it=identities_.erase(it); else ++it;
    for(auto it=reliable_.begin();it!=reliable_.end();)
      if(!identities_.count(it->first) || pts-it->second.pts>gap_) it=reliable_.erase(it); else ++it;
    auto plausible=[&](int id,const cv::Rect_<float>& box) {
      auto found=reliable_.find(id);
      if(found==reliable_.end() || found->second.pts==identities_.at(id).pts) return true;
      const auto& prior=found->second;
      const float dx=Cx(box)-Cx(prior.box),dy=Cy(box)-Cy(prior.box);
      // A weak observation is not evidence of a turn. Reject only a large
      // backwards teleport after it, not ordinary jitter or an observed return.
      const float motion=std::hypot(prior.vx,prior.vy)*std::min(float(pts-prior.pts),0.5f);
      return motion<=0.1f*std::min(prior.box.width,prior.box.height) ||
        dx*prior.vx+dy*prior.vy>=0 ||
        std::hypot(dx,dy)<=std::hypot(prior.box.width,prior.box.height);
    };
    for(auto it=alias_.begin();it!=alias_.end();)
      if(!identities_.count(it->second)) it=alias_.erase(it); else ++it;
    std::set<int> used;
    std::vector<size_t> fresh;
    for(size_t i=0;i<result.size();++i) {
      // A revived internal track whose identity is already taken this frame
      // competes like a new one, so no identity is ever emitted twice.
      auto alias=alias_.find(result[i].track_id);
      if(alias!=alias_.end() && !used.count(alias->second) &&
         plausible(alias->second,boxes[result[i].observation].box)) {
        result[i].track_id=alias->second;used.insert(alias->second);
      }
      else fresh.push_back(i);
    }
    constexpr size_t kNone=static_cast<size_t>(-1);
    struct Candidate {size_t result,observation;};
    std::vector<Candidate> candidates;
    std::set<size_t> matched;
    for(const auto& r:result) matched.insert(r.observation);
    for(size_t i:fresh) candidates.push_back({i,result[i].observation});
    for(size_t o=0;o<boxes.size();++o)
      if(eligible[o] && !matched.count(o)) candidates.push_back({kNone,o});
    std::vector<int> available;
    for(const auto& [id,state]:identities_)if(!used.count(id)&&state.pts<pts)available.push_back(id);
    std::vector<std::vector<double>> costs(candidates.size(),std::vector<double>(available.size(),4.0));
    for(size_t c=0;c<candidates.size();++c) {
      const auto& box=boxes[candidates[c].observation];
      for(size_t j=0;j<available.size();++j) {
        const auto& state=identities_.at(available[j]);
        if(state.label!=box.label || !plausible(available[j],box.box))continue;
        const float cost=Fit(state,box.box,pts);
        if(cost>=0)costs[c][j]=cost;
      }
    }
    std::vector<int> assignment(candidates.size(),-1);
    // Bound cubic recovery work. Crowded inputs retain the previous greedy
    // recovery behavior rather than blocking every channel on this CPU task.
    if(candidates.size()<=128 && available.size()<=128)assignment=Assign(costs,4.0);
    else {
      std::vector<std::tuple<double,size_t,size_t>> pairs;
      for(size_t c=0;c<costs.size();++c)for(size_t j=0;j<available.size();++j)
        if(costs[c][j]<4.0)pairs.emplace_back(costs[c][j],c,j);
      std::sort(pairs.begin(),pairs.end());std::set<size_t> assigned;
      for(const auto& [cost,c,j]:pairs)if(assignment[c]<0&&!assigned.count(j)) {
        assignment[c]=int(j);assigned.insert(j);
      }
    }
    std::vector<char> taken(candidates.size(),0);
    std::vector<ByteTrackMatch> continued;
    for(size_t c=0;c<candidates.size();++c) {
      if(assignment[c]<0)continue;
      const int id=available[assignment[c]];
      taken[c]=1;used.insert(id);
      const auto& candidate=candidates[c];
      if(candidate.result!=kNone) {alias_[result[candidate.result].track_id]=id;result[candidate.result].track_id=id;}
      else continued.push_back({candidate.observation,id,boxes[candidate.observation].box});
    }
    std::vector<bool> keep_result(result.size(),true);
    for(size_t c=0;c<candidates.size();++c) {
      if(taken[c] || candidates[c].result==kNone) continue;
      auto& r=result[candidates[c].result];
      // A rejected old alias is not permission to create a new weak identity.
      // Use the same birth threshold as the pinned ByteTrack implementation.
      if(boxes[candidates[c].observation].score<0.6f) {
        alias_.erase(r.track_id);keep_result[candidates[c].result]=false;continue;
      }
      if(next_id_==std::numeric_limits<int>::max()) throw std::overflow_error("Tracking identity space exhausted");
      alias_[r.track_id]=++next_id_;r.track_id=next_id_;used.insert(next_id_);
    }
    size_t write=0;
    for(size_t i=0;i<result.size();++i) if(keep_result[i]) result[write++]=result[i];
    result.resize(write);
    result.insert(result.end(),continued.begin(),continued.end());
    for(const auto& r:result) {
      const auto& now=boxes[r.observation];
      Identity next{now.label,now.box,pts};
      auto old=identities_.find(r.track_id);
      if(old!=identities_.end() && pts>old->second.pts) {
        // Smoothed velocity:a single 0.1 s step amplifies box jitter.
        const float dt=static_cast<float>(pts-old->second.pts),gain=std::min(1.f,dt/0.5f);
        next.vx=old->second.vx+gain*((Cx(now.box)-Cx(old->second.box))/dt-old->second.vx);
        next.vy=old->second.vy+gain*((Cy(now.box)-Cy(old->second.box))/dt-old->second.vy);
        const float limit=3*std::hypot(now.box.width,now.box.height),speed=std::hypot(next.vx,next.vy);
        if(speed>limit) {next.vx*=limit/speed;next.vy*=limit/speed;}
      }
      identities_[r.track_id]=next;
      // Weak (<0.25) continuations retain identity, but cannot steer the recovery
      // reference. This is a recovery floor, not a model probability estimate.
      if(now.score>=0.25f) {
        auto oldReliable=reliable_.find(r.track_id);
        if(oldReliable!=reliable_.end() && pts>oldReliable->second.pts) {
          const auto& prior=oldReliable->second;
          const float dt=static_cast<float>(pts-prior.pts),gain=std::min(1.f,dt/0.5f);
          next.vx=prior.vx+gain*((Cx(now.box)-Cx(prior.box))/dt-prior.vx);
          next.vy=prior.vy+gain*((Cy(now.box)-Cy(prior.box))/dt-prior.vy);
          const float limit=3*std::hypot(now.box.width,now.box.height),speed=std::hypot(next.vx,next.vy);
          if(speed>limit) {next.vx*=limit/speed;next.vy*=limit/speed;}
        }
        reliable_[r.track_id]=next;
      }
    }
  }
  std::map<int,int> alias_;
  std::map<int,Identity> identities_;
  std::map<int,Identity> reliable_;
  int next_id_=0;
  std::map<std::string,Group> groups_;
  double gap_,last_=-1;
  int fps_;
};
}

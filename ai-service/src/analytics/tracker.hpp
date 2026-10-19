// Copyright AINVR. Source-time tracking and rule state; no image/model inference.
#pragma once
#include "assignment.hpp"
#include "motion_filter.hpp"
#include "geometry.hpp"
#include <cstdint>
#include <map>
#include <set>
#include <string>
namespace ai_service::analytics {
using Box=std::array<double,4>; // normalized source x,y,w,h
struct Observation { std::string label; Box box; };
struct Rule {
  std::string id,type,label; // line, region, dwell
  std::vector<Point> points;
  double dwell_seconds=5;
};
struct Options {
  double max_gap_seconds=2, association_distance=0.15, line_hysteresis=0.005;
  int confirmation_hits=3, maximum_tracks=256;
  std::vector<Rule> rules;
};
struct Track {
  uint64_t id=0;
  std::string label;
  Box box{};
  Point anchor{},velocity{};
  double seen=0;
  int hits=0;
  bool observed=false,confirmed=false;
};
struct Event {
  std::string id,rule_id,type,direction;
  uint64_t track_id=0;
  double pts_seconds=0;
};
struct Update {
  std::vector<Track> tracks;
  std::vector<Event> events;
  std::vector<uint64_t> observation_tracks;
  bool accepted=true;
};
class Tracker {
 public:
  explicit Tracker(Options options):options_(std::move(options)) {Validate();}
  void Reset(std::string session) {
    if(session.empty()) throw std::invalid_argument("Tracking session is required");
    session_=std::move(session);tracks_.clear();states_.clear();filters_.clear();
    last_pts_=-1;next_id_=1;next_event_=1;
  }
  Update Process(double pts,const std::vector<Observation>& observations) {
    if(session_.empty()) throw std::logic_error("Reset tracking session before processing");
    if(!std::isfinite(pts)||pts<0) throw std::invalid_argument("Invalid source PTS");
    if(observations.size()>1000) throw std::invalid_argument("Too many observations");
    for(const auto& o:observations) {
      if(o.label.empty()) throw std::invalid_argument("Missing observation identity");
      for(double x:o.box) if(!std::isfinite(x)) throw std::invalid_argument("Nonfinite box");
      if(o.box[0]<0||o.box[1]<0||o.box[2]<=0||o.box[3]<=0||
         o.box[0]+o.box[2]>1.000001||o.box[1]+o.box[3]>1.000001)
        throw std::invalid_argument("Invalid normalized source box");
    }
    Update out;
    out.observation_tracks.resize(observations.size());
    if(pts<=last_pts_) {out.accepted=false;return out;}
    last_pts_=pts;
    for(auto it=tracks_.begin();it!=tracks_.end();) {
      if(pts-it->second.seen>options_.max_gap_seconds) {
        states_.erase(it->first);filters_.erase(it->first);it=tracks_.erase(it);
      } else {it->second.observed=false;++it;}
    }
    std::vector<uint64_t> ids;
    std::vector<std::vector<double>> costs;
    for(const auto& [id,t]:tracks_) {
      ids.push_back(id);
      std::vector<double> row;
      auto& motion=filters_.at(id);
      motion.filter.Predict(pts-motion.pts);
      motion.pts=pts;
      const Point predicted=Anchor(motion.filter.PredictedBox());
      for(const auto& o:observations) {
        auto p=Anchor(o.box);
        double distance=std::hypot(p[0]-predicted[0],p[1]-predicted[1]);
        row.push_back(t.label==o.label?distance/options_.association_distance:2.0);
      }
      costs.push_back(std::move(row));
    }
    auto assignments=Assign(costs,1.0);
    for(size_t i=0;i<ids.size();++i) {
      int j=assignments[i];
      if(j<0) continue;
      auto& t=tracks_.at(ids[i]);
      filters_.at(t.id).filter.Correct(observations[j].box);
      auto p=Anchor(observations[j].box);
      double dt=pts-t.seen;
      t.velocity={(p[0]-t.anchor[0])/dt,(p[1]-t.anchor[1])/dt};
      t.anchor=p;t.box=observations[j].box;t.seen=pts;t.observed=true;
      t.confirmed=++t.hits>=options_.confirmation_hits;
      out.observation_tracks[j]=t.id;
      Evaluate(t,pts,out.events);
    }
    for(size_t j=0;j<observations.size();++j) {
      if(out.observation_tracks[j] || tracks_.size()>=static_cast<size_t>(options_.maximum_tracks)) continue;
      const auto& o=observations[j];
      Track t;
      t.id=next_id_++;t.label=o.label;t.box=o.box;t.anchor=Anchor(o.box);
      t.seen=pts;t.hits=1;t.observed=true;t.confirmed=options_.confirmation_hits==1;
      out.observation_tracks[j]=t.id;
      tracks_.emplace(t.id,t);
      MotionState motion;motion.filter.Initialize(o.box);motion.pts=pts;
      filters_.emplace(t.id,std::move(motion));
      Evaluate(t,pts,out.events);
    }
    for(const auto& [id,t]:tracks_) out.tracks.push_back(t);
    return out;
  }
  // Consume authoritative tracker identities without a second association pass.
  // Zero IDs are unconfirmed/unassociated detections and do not drive rules.
  Update ProcessTracked(double pts,const std::vector<Observation>& observations,
                        const std::vector<uint64_t>& identities) {
    if(session_.empty()) throw std::logic_error("Tracking session is required");
    if(!std::isfinite(pts)||pts<0 || observations.size()!=identities.size() ||
       observations.size()>1000) throw std::invalid_argument("Invalid tracked observations");
    std::set<uint64_t> unique;
    for(size_t i=0;i<observations.size();++i) {
      const auto& o=observations[i];
      if(o.label.empty()) throw std::invalid_argument("Missing label");
      for(double v:o.box) if(!std::isfinite(v)) throw std::invalid_argument("Nonfinite box");
      if(o.box[0]<0||o.box[1]<0||o.box[2]<=0||o.box[3]<=0||
         o.box[0]+o.box[2]>1.000001||o.box[1]+o.box[3]>1.000001)
        throw std::invalid_argument("Invalid source box");
      if(identities[i] && !unique.insert(identities[i]).second)
        throw std::invalid_argument("Duplicate tracker identity");
      auto old=tracks_.find(identities[i]);
      if(old!=tracks_.end() && old->second.label!=o.label)
        throw std::invalid_argument("Tracker identity changed label");
    }
    Update out;
    out.observation_tracks.resize(observations.size());
    if(pts<=last_pts_) {out.accepted=false;return out;}
    last_pts_=pts;
    for(auto it=tracks_.begin();it!=tracks_.end();) {
      if(pts-it->second.seen>options_.max_gap_seconds) {
        states_.erase(it->first);filters_.erase(it->first);it=tracks_.erase(it);
      } else {it->second.observed=false;++it;}
    }
    for(size_t i=0;i<observations.size();++i) {
      const auto id=identities[i];
      if(!id) continue;
      const auto& o=observations[i];
      auto it=tracks_.find(id);
      if(it==tracks_.end()) {
        if(tracks_.size()>=static_cast<size_t>(options_.maximum_tracks)) continue;
        Track t;t.id=id;t.label=o.label;t.box=o.box;t.anchor=Anchor(o.box);
        t.seen=pts;t.hits=1;t.observed=true;
        t.confirmed=options_.confirmation_hits==1;
        it=tracks_.emplace(id,t).first;
      } else {
        auto& t=it->second;
        const auto anchor=Anchor(o.box);
        const double dt=pts-t.seen;
        t.velocity={(anchor[0]-t.anchor[0])/dt,(anchor[1]-t.anchor[1])/dt};
        t.anchor=anchor;t.box=o.box;t.seen=pts;t.observed=true;
        t.confirmed=++t.hits>=options_.confirmation_hits;
      }
      out.observation_tracks[i]=id;
      Evaluate(it->second,pts,out.events);
    }
    for(const auto& [id,t]:tracks_) out.tracks.push_back(t);
    return out;
  }
 private:
  struct RuleState {
    bool initialized=false,inside=false,dwell_emitted=false;
    int side=0;
    Point stable_anchor{};
    double entered=0;
  };
  static Point Anchor(Box b) {return {b[0]+b[2]/2,b[1]+b[3]};}
  void Validate() const {
    if(!std::isfinite(options_.max_gap_seconds)||options_.max_gap_seconds<=0||options_.max_gap_seconds>60||
       !std::isfinite(options_.association_distance)||options_.association_distance<=0||options_.association_distance>1||
       !std::isfinite(options_.line_hysteresis)||options_.line_hysteresis<0||options_.line_hysteresis>0.1||
       options_.confirmation_hits<1||options_.confirmation_hits>30||
       options_.maximum_tracks<1||options_.maximum_tracks>1000||options_.rules.size()>64)
      throw std::invalid_argument("Invalid tracking options");
    std::set<std::string> names;
    for(const auto& r:options_.rules) {
      if(r.id.empty()||!names.insert(r.id).second) throw std::invalid_argument("Duplicate/empty rule ID");
      if(r.type=="line") {
        if(r.points.size()!=2 || r.points[0]==r.points[1]) throw std::invalid_argument("Invalid line");
        for(auto p:r.points) for(double v:p)
          if(!std::isfinite(v)||v<0||v>1) throw std::invalid_argument("Invalid line point");
      } else if(r.type=="region"||r.type=="dwell") ValidatePolygon(r.points);
      else throw std::invalid_argument("Unknown rule type");
      if(!std::isfinite(r.dwell_seconds)||r.dwell_seconds<=0||r.dwell_seconds>86400)
        throw std::invalid_argument("Invalid dwell duration");
    }
  }
  void Emit(const Track& t,const Rule& r,double pts,const std::string& type,
            const std::string& direction,std::vector<Event>& events) {
    events.push_back({session_+":"+std::to_string(next_event_++),r.id,type,direction,t.id,pts});
  }
  void Evaluate(const Track& t,double pts,std::vector<Event>& events) {
    if(!t.confirmed) return;
    for(const auto& r:options_.rules) {
      if(!r.label.empty()&&r.label!=t.label) continue;
      auto& state=states_[t.id][r.id];
      if(r.type=="line") {
        auto a=r.points[0],b=r.points[1];
        double distance=Cross(a,b,t.anchor)/std::hypot(b[0]-a[0],b[1]-a[1]);
        int side=distance>options_.line_hysteresis?1:(distance<-options_.line_hysteresis?-1:0);
        if(!side) continue;
        if(state.initialized&&state.side!=side&&Crosses(a,b,state.stable_anchor,t.anchor))
          Emit(t,r,pts,"line_crossing",side>0?"negative_to_positive":"positive_to_negative",events);
        state.initialized=true;state.side=side;state.stable_anchor=t.anchor;
      } else {
        bool inside=Inside(r.points,t.anchor);
        if(!state.initialized) {
          // First sight inside is presence, not evidence of a boundary crossing.
          state.initialized=true;state.inside=inside;state.entered=pts;
        } else if(state.inside!=inside) {
          state.inside=inside;state.entered=pts;state.dwell_emitted=false;
          if(r.type=="region") Emit(t,r,pts,inside?"region_enter":"region_exit","",events);
        }
        if(r.type=="dwell"&&inside&&!state.dwell_emitted&&pts-state.entered>=r.dwell_seconds) {
          Emit(t,r,pts,"region_dwell","",events);state.dwell_emitted=true;
        }
      }
    }
  }
  struct MotionState {MotionFilter filter; double pts=0;};
  std::map<uint64_t,MotionState> filters_;
  Options options_;
  std::string session_;
  double last_pts_=-1;
  uint64_t next_id_=1,next_event_=1;
  std::map<uint64_t,Track> tracks_;
  std::map<uint64_t,std::map<std::string,RuleState>> states_;
};
} // namespace ai_service::analytics

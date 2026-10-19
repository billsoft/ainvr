// Copyright AINVR. Short-loss coasting ("dead reckoning") for display only:predicted boxes for
// lost targets, never detections, never archived, last in SEI under budget.
#include "../../ai-service/src/analytics/frame_analytics.hpp"
#include "../../ai-service/src/analytics/candidate_results.hpp"
#include "../../ai-service/src/stream/sei.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service;
static FrameResult Frame(int64_t pts_ns,std::vector<std::array<double,4>> boxes,double conf=.9) {
  FrameResult f;f.channel_id="coast";f.frame_width=1000;f.frame_height=1000;f.frame_pts_ns=pts_ns;f.timestamp=1;
  for(const auto& b:boxes) {
    Detection d;d.bbox={b[0],b[1],b[2],b[3]};d.class_id=0;d.class_name="person";d.label_id="person";
    d.confidence=conf;d.confidence_known=true;f.detections.push_back(d);
  }
  return f;
}
static nlohmann::json Coasting(const FrameResult& f) {
  auto out=nlohmann::json::array();
  for(const auto& t:f.model_extra["analytics"]["tracks"]) if(t.contains("predicted_bbox")) out.push_back(t);
  return out;
}
int main() {
  // 0. Configuration:default 1 s, range 0..2 s and never longer than the identity gap.
  {
    assert(analytics::Config{}.coast_seconds==1.0);
    assert(analytics::FromJson({{"coast_seconds",0}}).coast_seconds==0);
    assert(analytics::FromJson({{"coast_seconds",2}}).coast_seconds==2);
    bool rejected=false;try{analytics::FromJson({{"coast_seconds",2.5}});}catch(const std::exception&){rejected=true;}assert(rejected);
    rejected=false;try{analytics::FromJson({{"coast_seconds",1.5},{"max_gap_seconds",1}});}catch(const std::exception&){rejected=true;}assert(rejected);
    rejected=false;try{analytics::FromJson({{"coast_seconds",-0.1}});}catch(const std::exception&){rejected=true;}assert(rejected);
    assert(analytics::ToJson(analytics::FromJson({{"coast_seconds",0.5}}))["coast_seconds"]==0.5);
  }
  analytics::Config config;config.enabled=true;config.options.confirmation_hits=1;
  // 1. Moving right at 200 px/s, 10 fps;detections stop for 1.3 s.
  {
    analytics::FrameAnalytics tracker(analytics::PhaseEffective(config));
    std::string id;
    for(int k=0;k<10;++k) {
      auto f=Frame(int64_t(k)*100000000,{{100+20.0*k,400,100,200}});tracker.Apply(f,1,1);
      id=f.detections[0].track_id;
    }
    assert(!id.empty());
    double last_x=280;int coasted=0;
    for(int k=10;k<23;++k) {
      auto f=Frame(int64_t(k)*100000000,{});tracker.Apply(f,1,1);
      assert(f.detections.empty());                       // never a detection (archive/snapshot input)
      const auto c=Coasting(f);
      const double lost=(k-9)*0.1;
      if(lost<=1.0+1e-9) {
        assert(c.size()==1 && c[0]["track_id"]==id);
        assert(c[0]["observation"]=="lost" && c[0]["class_name"]=="person");
        const double x=c[0]["predicted_bbox"]["x"].get<double>();
        assert(x>last_x);                                   // follows the motion
        last_x=x;++coasted;
      } else assert(c.empty());                             // stops after coast_seconds
      // Display-only geometry is reported as a prediction, never as an observation.
      for(const auto& d:analytics::CoastDetections(f)) {
        assert(!d.confidence_known && d.track_id==id);
        assert(d.model_extra.value("predicted",false));
      }
    }
    assert(coasted==10);
    // After ~1 s at ~200 px/s the prediction has advanced about 200 px.
    assert(last_x>420 && last_x<560);
  }
  // 2. coast_seconds=0 disables coasting.
  {
    auto off=config;off.coast_seconds=0;
    analytics::FrameAnalytics tracker(analytics::PhaseEffective(off));
    for(int k=0;k<10;++k){auto f=Frame(int64_t(k)*100000000,{{100+20.0*k,400,100,200}});tracker.Apply(f,1,1);}
    auto f=Frame(int64_t(10)*100000000,{});tracker.Apply(f,1,1);
    assert(Coasting(f).empty() && analytics::CoastDetections(f).empty());
  }
  // 3. Predictions leaving the image are clipped and dropped when nothing remains visible.
  {
    analytics::FrameAnalytics tracker(analytics::PhaseEffective(config));
    for(int k=0;k<10;++k){auto f=Frame(int64_t(k)*100000000,{{600+25.0*k,400,100,200}});tracker.Apply(f,1,1);}
    bool dropped=false;
    for(int k=10;k<20;++k) {
      auto f=Frame(int64_t(k)*100000000,{});tracker.Apply(f,1,1);
      for(const auto& c:Coasting(f)) {
        const auto& b=c["predicted_bbox"];
        assert(b["x"].get<double>()>=0 && b["x"].get<double>()+b["w"].get<double>()<=1000.0001);
      }
      if(Coasting(f).empty()) dropped=true;
    }
    assert(dropped);
  }
  // 3b. A target kept only by a below-display-threshold candidate is shown as a low-confidence
  //     display box (real observation, not archived), not as a gap.
  {
    analytics::FrameAnalytics tracker(analytics::PhaseEffective(config));
    for(int k=0;k<10;++k){auto f=Frame(int64_t(k)*100000000,{{100+20.0*k,400,100,200}});tracker.Apply(f,1,1);}
    auto tracked=Frame(int64_t(10)*100000000,{{300,400,100,200}},.15);   // tracking candidate
    tracker.Apply(tracked,1,1);
    FrameResult visible=tracked;visible.detections.clear();              // below the display threshold
    analytics::CopyTrackIdentities(tracked.detections,visible.detections);
    analytics::MarkHiddenObservations(visible);
    const auto shown=analytics::CoastDetections(visible);
    assert(shown.size()==1 && shown[0].model_extra.value("display_kind","")=="low_confidence");
    assert(!shown[0].model_extra.value("predicted",false) && shown[0].bbox[0]==300 && shown[0].class_name=="person");
    // When the box is visible as a normal detection nothing extra is drawn.
    auto normal=Frame(int64_t(11)*100000000,{{320,400,100,200}});tracker.Apply(normal,1,1);
    analytics::MarkHiddenObservations(normal);
    assert(analytics::CoastDetections(normal).empty());
  }
  // 4. SEI:predictions are flagged, carry no confidence, come after observed boxes and go first.
  {
    std::vector<Detection> real(2);
    for(size_t i=0;i<real.size();++i){real[i].class_name="person";real[i].confidence=.8;real[i].confidence_known=true;
      real[i].track_id="s:"+std::to_string(i+1);real[i].bbox={10.0*i,10,50,100};}
    Detection p;p.class_name="person";p.track_id="s:9";p.bbox={500,500,50,100};p.confidence_known=false;
    p.model_extra={{"predicted",true}};
    const auto full=sei::build_result_payload("c",1,0,real,4096,nlohmann::json::object(),{p});
    const auto json=nlohmann::json::parse(std::string(full.begin(),full.end()));
    assert(json["det"].size()==3 && json["det"][2]["pr"]==1 && json["det"][2]["p"].is_null());
    assert(!json["det"][0].contains("pr") && json["det"][0]["t"]=="s:1");
    // Tight budget:observed boxes survive, the prediction is dropped first.
    const auto tight=sei::build_result_payload("c",1,0,real,int(full.size())-5,nlohmann::json::object(),{p});
    const auto small=nlohmann::json::parse(std::string(tight.begin(),tight.end()));
    assert(small["det"].size()==2);
    for(const auto& d:small["det"]) assert(!d.contains("pr"));
    Detection low=p;low.model_extra={{"display_kind","low_confidence"}};
    const auto mixed=sei::build_result_payload("c",1,0,{},4096,nlohmann::json::object(),{p,low});
    const auto mj=nlohmann::json::parse(std::string(mixed.begin(),mixed.end()));
    assert(mj["det"][0]["pr"]==1 && !mj["det"][0].contains("lc"));
    assert(mj["det"][1]["lc"]==1 && !mj["det"][1].contains("pr"));
    // Only predictions (target briefly lost) still produce a payload.
    const auto only=sei::build_result_payload("c",1,0,{},4096,nlohmann::json::object(),{p});
    assert(!only.empty());
  }
  std::cout<<"{\"status\":\"completed\",\"suite\":\"analytics_coast\"}\n";
}

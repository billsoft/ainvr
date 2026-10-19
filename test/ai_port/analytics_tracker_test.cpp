// Copyright AINVR.
#include "../../ai-service/src/analytics/tracker.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::analytics;
Observation At(double x,double y=0.5,std::string label="person") {
  return {label,{x-0.025,y-0.1,0.05,0.1}};
}
int main() {
  Options options;
  options.confirmation_hits=1;
  options.association_distance=0.3;
  options.rules={{"line","line","",{{0.5,0.2},{0.5,0.8}},5}};
  Tracker t(options);t.Reset("session-a");
  auto a=t.Process(0,{At(0.4)});
  assert(a.tracks.size()==1&&a.events.empty());
  auto b=t.Process(1,{At(0.6)});
  assert(b.observation_tracks[0]==a.observation_tracks[0]);
  assert(b.events.size()==1 && b.events[0].type=="line_crossing");
  assert(std::abs(b.tracks[0].velocity[0]-0.2)<1e-9);
  assert(!t.Process(1,{At(0.7)}).accepted);
  assert(t.Process(1.5,{}).events.empty());
  auto expired=t.Process(4,{At(0.6)});
  assert(expired.observation_tracks[0]!=a.observation_tracks[0]);
  assert(expired.events.empty());
  t.Reset("session-b");
  assert(t.Process(0,{At(0.4)}).events.empty());
  auto crossed=t.Process(1,{At(0.6)});
  assert(crossed.events[0].id!=b.events[0].id);
  Tracker edge(options);edge.Reset("edge");
  edge.Process(0,{At(0.49)});
  assert(edge.Process(1,{At(0.499)}).events.empty());
  assert(edge.Process(2,{At(0.501)}).events.empty());
  assert(edge.Process(3,{At(0.51)}).events.size()==1);
  Tracker outside(options);outside.Reset("outside");
  outside.Process(0,{At(0.4,0.9)});
  assert(outside.Process(1,{At(0.6,0.9)}).events.empty());
  options.rules={{"region","region","",{{0.3,0.3},{0.7,0.3},{0.7,0.7},{0.3,0.7}},5},
                 {"dwell","dwell","",{{0.3,0.3},{0.7,0.3},{0.7,0.7},{0.3,0.7}},2}};
  Tracker region(options);region.Reset("region");
  region.Process(0,{At(0.2)});
  assert(region.Process(1,{At(0.4)}).events[0].type=="region_enter");
  assert(region.Process(2,{At(0.4)}).events.empty());
  assert(region.Process(3,{At(0.4)}).events[0].type=="region_dwell");
  assert(region.Process(4,{At(0.4)}).events.empty());
  region.Process(5,{At(0.6)});
  assert(region.Process(6,{At(0.8)}).events[0].type=="region_exit");
  Tracker labels(options);labels.Reset("labels");
  auto original=labels.Process(0,{At(0.4)});
  auto changed=labels.Process(1,{At(0.4,0.5,"car")});
  assert(original.observation_tracks[0]!=changed.observation_tracks[0]);
  options.confirmation_hits=3;
  Tracker tentative(options);tentative.Reset("tentative");
  assert(!tentative.Process(0,{At(0.4)}).tracks[0].confirmed);
  assert(!tentative.Process(1,{At(0.4)}).tracks[0].confirmed);
  assert(tentative.Process(2,{At(0.4)}).tracks[0].confirmed);
  // A missed source frame advances the filter once, but never the evidence box
  // or rule state. Reacquisition uses the accumulated source-time prediction.
  Options motionOptions;motionOptions.confirmation_hits=1;
  motionOptions.association_distance=0.12;motionOptions.max_gap_seconds=3;
  motionOptions.rules={{"cross","line","",{{0.55,0},{0.55,1}},5}};
  Tracker motion(motionOptions);motion.Reset("motion");
  const auto id=motion.Process(0,{At(0.2)}).observation_tracks[0];
  for(int i=1;i<=3;++i)
    assert(motion.Process(i,{At(0.2+0.1*i)}).observation_tracks[0]==id);
  const auto missing=motion.Process(4,{});
  assert(missing.events.empty() && !missing.tracks[0].observed);
  assert(std::abs(missing.tracks[0].anchor[0]-0.5)<1e-9);
  assert(!motion.Process(3.5,{At(0.9)}).accepted);
  const auto recovered=motion.Process(5,{At(0.7)});
  assert(recovered.observation_tracks[0]==id);
  assert(recovered.events.size()==1);
  assert(motion.Process(9,{At(0.75)}).observation_tracks[0]!=id);
  std::cout<<"analytics lifecycle, source time, crossing, region, dwell: PASS\n";
}

#include "../../ai-service/src/analytics/motion_filter.hpp"
#include "../../ai-service/src/analytics/score_association.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::analytics;
int main() {
  MotionFilter f;f.Initialize({.1,.2,.1,.2});
  auto before=f.PositionVariance();f.Predict(1);
  assert(f.PositionVariance()[0]>before[0]);
  f.Correct({.2,.2,.1,.2});
  assert(f.PositionVariance()[0]<before[0]);
  assert(f.Velocity()[0]>.08&&f.Velocity()[0]<.12);
  f.Predict(.5);
  assert(std::abs(f.PredictedBox()[0]-.25)<.01);
  for(int i=0;i<1000;++i) {
    f.Predict(.01);f.Correct({.25+i*.001,.2,.1,.2});
    for(double v:f.PositionVariance()) assert(std::isfinite(v)&&v>=0);
  }
  MotionFilter whole,parts;whole.Initialize({.1,.2,.1,.2});parts.Initialize({.1,.2,.1,.2});
  whole.Predict(1);parts.Predict(.4);parts.Predict(.6);
  for(size_t i=0;i<4;++i)assert(std::abs(whole.PositionVariance()[i]-parts.PositionVariance()[i])<1e-12);
  auto matched=AssociateScores({{.2,.1},{2,.2}},{.9,.2},{true,true});
  assert((matched.matched==std::vector<int>{0,1}));
  assert(matched.new_candidates.empty());
  auto births=AssociateScores({}, {.2,.55,.9},{});
  assert((births.new_candidates==std::vector<int>{2}));
  auto tentative=AssociateScores({{.1}},{.2},{false});
  assert(tentative.matched[0]==-1);
  bool rejected=false;
  try {AssociateScores({}, {std::nullopt},{});} catch(const std::invalid_argument&) {rejected=true;}
  assert(rejected);
  std::cout<<"motion filter variable PTS, covariance, and score tiers: PASS\n";
}

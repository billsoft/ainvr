#include "../../ai-service/src/analytics/bytetrack_adapter.hpp"
#include "../../ai-service/src/analytics/tracker.hpp"
#include <cassert>
using namespace ai_service::analytics;
int main() {
  ByteTrackAdapter association;
  Options options;options.confirmation_hits=1;
  options.rules.push_back({"door","line","person",{{0.5,0},{0.5,1}},5});
  ai_service::analytics::Tracker rules(options);rules.Reset("test-session");
  auto run=[&](double pts,float x) {
    std::vector<ScoredBox> boxes{{"person",{x,20,40,40},0.9f}};
    auto matches=association.Process(pts,boxes);
    std::vector<uint64_t> ids(1,0);
    for(auto m:matches) ids[m.observation]=m.track_id;
    return rules.ProcessTracked(pts,{{"person",{x/100.0,0.2,0.4,0.4}}},ids);
  };
  auto first=run(0,25);
  assert(first.events.empty());
  auto next=run(0.1,35);
  assert(next.events.size()==1);
  assert(next.events[0].type=="line_crossing");
  assert(next.events[0].track_id==first.observation_tracks[0]);
  auto stale=rules.ProcessTracked(0.1,{},{});assert(!stale.accepted);
  auto missing=rules.ProcessTracked(0.2,{},{});
  assert(missing.events.empty() && !missing.tracks[0].observed);
  bool rejected=false;
  try {rules.ProcessTracked(0.3,{{"person",{0,0,0.1,0.1}},{"person",{0,0,0.1,0.1}}},
                           {1,1});}
  catch(const std::invalid_argument&) {rejected=true;}
  assert(rejected);
}

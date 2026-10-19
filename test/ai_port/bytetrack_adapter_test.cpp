#include "../../ai-service/src/analytics/bytetrack_adapter.hpp"
#include <cassert>
using namespace ai_service::analytics;
int main() {
  ByteTrackAdapter tracker;
  ScoredBox person{"person",{10,10,20,40},0.9f};
  ScoredBox car{"car",{10,10,20,40},0.9f};
  auto initial=tracker.Process(0,{person,car});
  assert(initial.size()==2);
  int person_id=0,car_id=0;
  for(auto m:initial) (m.observation==0?person_id:car_id)=m.track_id;
  assert(person_id && car_id && person_id!=car_id);
  // Identical geometry and reversed input order must preserve business labels.
  auto next=tracker.Process(0.1,{car,person});
  for(auto m:next) assert(m.track_id==(m.observation==0?car_id:person_id));
  person.score=0.2f;
  auto low=tracker.Process(0.2,{person});
  assert(low.size()==1 && low[0].track_id==person_id && low[0].observation==0);
  ScoredBox newcomer{"new",{20,20,20,40},0.2f};
  assert(tracker.Process(0.3,{newcomer}).empty());
  assert(tracker.Process(0.4,{}).empty());
  tracker.Reset();
  person.score=0.9f;
  auto reset=tracker.Process(0,{person});
  assert(reset.size()==1 && reset[0].track_id!=person_id);
}

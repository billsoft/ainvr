// Copyright AINVR. Lost-track recovery after missed detections at low frame rates.
#include "../../ai-service/src/analytics/bytetrack_adapter.hpp"
#include <cassert>
#include <iostream>
using ai_service::analytics::ByteTrackAdapter;
using ai_service::analytics::ScoredBox;
static ScoredBox person(float x,float y,float s=300) {return {"person",{x,y,s,s},.9f};}
static int only_id(const std::vector<ai_service::analytics::ByteTrackMatch>& m) {assert(m.size()==1);return m[0].track_id;}
int main() {
  // 1. Slow walk, two missed detections, then a jump with zero overlap (corridor P4 at ~5 fps).
  {
    ByteTrackAdapter t(2,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    assert(id>0);
    t.Process(1.2,{});t.Process(1.4,{});
    t.Process(1.6,{person(700,400)});            // ~330 px centre jump, box diagonal ~424 px
    const int again=only_id(t.Process(1.8,{person(690,395)}));
    assert(again==id);
  }
  // 2. A jump beyond the box diagonal is a different target:new identity.
  {
    ByteTrackAdapter t(2,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    t.Process(1.2,{});t.Process(1.4,{});
    t.Process(1.6,{person(300,100)});
    const int other=only_id(t.Process(1.8,{person(295,100)}));
    assert(other!=id);
  }
  // 3. A track that is still observed is never handed to a nearby newcomer.
  {
    ByteTrackAdapter t(2,5);int a=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)a=only_id(m);}
    int newcomer=0;
    for(int k=6;k<9;++k) {
      auto m=t.Process(k*.2,{person(1000+10*k,500),person(1000+10*k+320,500)});
      for(const auto& x:m) if(x.observation==0) assert(x.track_id==a); else newcomer=x.track_id;
    }
    assert(newcomer!=0 && newcomer!=a);
  }
  // 4. Too long a gap (beyond max_gap_seconds) is not recovered.
  {
    ByteTrackAdapter t(1,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    t.Process(3.0,{person(800,450)});
    const int late=only_id(t.Process(3.2,{person(790,445)}));
    assert(late!=id);
  }
  std::cout<<"{\"status\":\"completed\",\"suite\":\"bytetrack_recovery\"}\n";
}

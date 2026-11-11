// Copyright AINVR. Near-duplicate measurements must not create or recover a second identity.
#include "../../ai-service/src/analytics/bytetrack_adapter.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::analytics;
static ScoredBox box(float x,float score,const char* label="person") {
  return {label,{x,100,200,400},score};
}
int main() {
  for (double fps : {2.,3.,4.,6.}) {
    ByteTrackAdapter t;
    int id=0;
    // Score order deliberately differs from input order. Suppressed measurements
    // must never re-enter the unmatched-observation recovery path.
    for(int k=0;k<20;++k) {
      float x=100+10*k;
      auto m=t.Process(k/fps,{box(x+1,.2f),box(x,.9f),box(x+2,.7f)});
      assert(m.size()==1 && m[0].observation==1);
      if(id) assert(m[0].track_id==id); else id=m[0].track_id;
    }
    // A genuine return along the same path is supported, not disabled globally.
    for(int k=20;k<40;++k) {
      auto m=t.Process(k/fps,{box(290-10*(k-19),k<22?.2f:.9f)});
      assert(m.size()==1 && m[0].track_id==id);
    }
  }
  // Normal overlap and different classes are not duplicates.
  {
    ByteTrackAdapter t;
    auto m=t.Process(0,{box(100,.9f),box(160,.85f),box(100,.8f,"bag")});
    assert(m.size()==3);
  }
  // New low-score objects still cannot create identities.
  {
    ByteTrackAdapter t;
    assert(t.Process(0,{box(100,.2f),box(101,.15f)}).empty());
  }
  // The losing duplicate of a current target cannot revive another lost ID.
  {
    ByteTrackAdapter t;
    int target=0;
    for(int k=0;k<6;++k) {
      auto m=t.Process(k*.2,{box(100,.9f),box(420,.9f)});
      assert(m.size()==2);
      for(auto x:m)if(x.observation==0)target=x.track_id;
    }
    auto m=t.Process(1.2,{box(105,.9f),box(106,.3f)});
    assert(m.size()==1 && m[0].track_id==target);
  }
  // A weak occlusion box must not drag the recovery prediction onto a different
  // person on the other side of the scene (the 2 FPS reverse-count regression).
  {
    ByteTrackAdapter t;
    int old=0;
    for(int k=0;k<5;++k) {
      auto m=t.Process(k*.5,{{"person",{1438.f+40*k,368,262,420},.8f}});
      assert(m.size()==1);old=m[0].track_id;
    }
    t.Process(2.52,{{"person",{1147,326,404,483},.19f}});
    auto m=t.Process(3.0,{{"person",{451,54,239,426},.8f}});
    for(auto x:m)assert(x.track_id!=old);
    m=t.Process(3.52,{{"person",{369,159,270,400},.8f}});
    assert(m.size()==1 && m[0].track_id!=old);
  }
  // Irregular source cadence: identity and a real turn must survive changing
  // intervals without interpreting a missed sample as a new person.
  {
    ByteTrackAdapter t;
    const double steps[]={1./6,1./2,1./4,1./3,.8};
    double pts=0;int id=0;
    for(int k=0;k<60;++k) {
      pts+=steps[k%5];
      const float x=k<30?100+12*k:460-12*(k-30);
      auto m=t.Process(pts,{box(x,k>3&&k%9==0?.2f:.9f),box(x+1,.15f)});
      assert(m.size()==1 && m[0].observation==0);
      if(id)assert(m[0].track_id==id);else id=m[0].track_id;
    }
  }
  std::cout<<"duplicate identity regression passed\n";
}

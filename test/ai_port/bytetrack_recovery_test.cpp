// Copyright AINVR. Identity layer over ByteTrack:lost-track prediction, low-score continuation,
// shape gate, class isolation, frame-rate independence and duplicate-free public identities.
#include "../../ai-service/src/analytics/bytetrack_adapter.hpp"
#include <cassert>
#include <iostream>
#include <set>
using ai_service::analytics::ByteTrackAdapter;
using ai_service::analytics::ByteTrackMatch;
using ai_service::analytics::ScoredBox;
static ScoredBox box(float x,float y,float w,float h,float s=.9f,const char* label="person") {return {label,{x,y,w,h},s};}
static ScoredBox person(float x,float y,float s=300) {return box(x,y,s,s);}
static int id_of(const std::vector<ByteTrackMatch>& m,size_t observation) {
  for(const auto& x:m) if(x.observation==observation) return x.track_id;
  return 0;
}
static int only_id(const std::vector<ByteTrackMatch>& m) {assert(m.size()==1);return m[0].track_id;}
static void unique_ids(const std::vector<ByteTrackMatch>& m) {
  std::set<int> s;for(const auto& x:m) assert(s.insert(x.track_id).second);
}
// Walk right at `speed` px/s for `seconds`, `fps` frames per second; returns the identity.
static int walk(ByteTrackAdapter& t,double& now,float& x,float speed,double seconds,double fps,float y=500,float s=.9f) {
  int id=0;
  for(int k=0;k<int(seconds*fps+.5);++k) {
    now+=1/fps;x+=speed/fps;auto m=t.Process(now,{box(x,y,200,400,s)});unique_ids(m);
    if(!m.empty()) id=m[0].track_id;
  }
  return id;
}
int main() {
  // 1. Slow walk, two missed detections, then a jump with zero overlap (corridor P4 at ~5 fps).
  {
    ByteTrackAdapter t(2,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    assert(id>0);
    t.Process(1.2,{});t.Process(1.4,{});
    t.Process(1.6,{person(700,400)});
    assert(only_id(t.Process(1.8,{person(690,395)}))==id);
  }
  // 2. A jump far beyond the predicted box is a different target:new identity.
  {
    ByteTrackAdapter t(2,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    t.Process(1.2,{});t.Process(1.4,{});
    t.Process(1.6,{person(100,100)});
    assert(only_id(t.Process(1.8,{person(95,100)}))!=id);
  }
  // 3. A track that is still observed is never handed to a nearby newcomer.
  {
    ByteTrackAdapter t(2,5);int a=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)a=only_id(m);}
    int newcomer=0;
    for(int k=6;k<9;++k) {
      auto m=t.Process(k*.2,{person(1000+10*k,500),person(1000+10*k+320,500)});unique_ids(m);
      for(const auto& x:m) if(x.observation==0) assert(x.track_id==a); else newcomer=x.track_id;
    }
    assert(newcomer!=0 && newcomer!=a);
  }
  // 4. Lost longer than max_gap_seconds is not recovered.
  {
    ByteTrackAdapter t(1,5);int id=0;
    for(int k=0;k<6;++k){auto m=t.Process(k*.2,{person(1000+10*k,500)});if(k>0)id=only_id(m);}
    t.Process(3.0,{person(800,450)});
    assert(only_id(t.Process(3.2,{person(790,445)}))!=id);
  }
  // 5. Inertial prediction:200 px/s, unseen for 0.8 s at 10 fps, reappears where the motion
  //    leads (no overlap with the last box) -> same identity.
  {
    ByteTrackAdapter t(2,10);double now=0;float x=100;
    const int id=walk(t,now,x,200,1.0,10);assert(id>0);
    for(int k=0;k<8;++k){now+=.1;x+=20;t.Process(now,{});}
    now+=.1;x+=20;
    assert(id_of(t.Process(now,{box(x,500,200,400)}),0)==id);
  }
  // 6. Low-score detections continue a lost identity (ByteTrack alone needs IoU>=0.5 for them)
  //    and get its ID;they never start a new identity.
  {
    ByteTrackAdapter t(2,10);double now=0;float x=100;
    const int id=walk(t,now,x,150,1.0,10);
    // Partly occluded:low confidence, smaller box (IoU with the prediction < 0.5, which
    // ByteTrack's low-score stage would reject).
    for(int k=0;k<6;++k) {
      now+=.1;x+=15;auto m=t.Process(now,{box(x+60,560,140,280,.3f)});
      assert(id_of(m,0)==id);
    }
    const auto far=t.Process(now+.1,{box(1500,100,150,330,.3f)});
    assert(far.empty());
  }
  // 7. Shape gate:a box at the predicted place with a very different aspect ratio is not the same target.
  {
    ByteTrackAdapter t(2,10);double now=0;float x=100;
    const int id=walk(t,now,x,100,1.0,10);
    for(int k=0;k<3;++k){now+=.1;t.Process(now,{});}
    // IoU with the prediction < 0.2 (outside ByteTrack's own association), centre within the
    // recovery distance, but the aspect ratio differs ~4.7x.
    now+=.1;t.Process(now,{box(x+120,650,420,180)});
    now+=.1;const auto m=t.Process(now,{box(x+125,650,420,180)});
    assert(id_of(m,0)!=0 && id_of(m,0)!=id);
  }
  // 8. Classes are separate channels:a car at a lost person's predicted place never takes the person's ID.
  {
    ByteTrackAdapter t(2,10);double now=0;float x=100;
    const int id=walk(t,now,x,100,1.0,10);
    for(int k=0;k<3;++k){now+=.1;t.Process(now,{});}
    now+=.1;t.Process(now,{box(x+30,500,200,400,.9f,"car")});
    now+=.1;const auto m=t.Process(now,{box(x+40,500,200,400,.9f,"car")});
    assert(id_of(m,0)!=id);
  }
  // 9. Frame-rate independent:the same 0.6 s loss is bridged at 5, 10 and 15 fps.
  for(double fps:{5.0,10.0,15.0}) {
    ByteTrackAdapter t(2,int(fps));double now=0;float x=100;
    const int id=walk(t,now,x,180,1.2,fps);
    for(int k=0;k<int(.6*fps+.5);++k){now+=1/fps;x+=180/fps;t.Process(now,{});}
    now+=1/fps;x+=180/fps;
    assert(id_of(t.Process(now,{box(x,500,200,400)}),0)==id);
  }
  // 10. Public identities are the adapter's own and never repeat within a frame, even when
  //     ByteTrack revives an old internal track while a new one exists for the same person.
  {
    ByteTrackAdapter t(2,10);double now=0;
    for(int k=0;k<200;++k) {
      now+=.1;std::vector<ScoredBox> b;
      for(int j=0;j<6;++j) {
        if((k+j)%7==0) continue;  // intermittent misses
        const float s=((k*3+j)%5==0)?.3f:.8f;
        b.push_back(box(100+j*260+float((k*7+j*13)%40),300+float((k*5+j*11)%30),180,380,s));
      }
      unique_ids(t.Process(now,b));
    }
  }
  std::cout<<"{\"status\":\"completed\",\"suite\":\"bytetrack_identity\"}\n";
}

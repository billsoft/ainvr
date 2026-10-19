// Copyright AINVR. Tests pinned upstream algorithm before any platform adaptation.
#include "BYTETracker.h"
#include <cassert>
#include <iostream>
int main() {
  BYTETracker tracker(30,30);
  Object high{{100,100,50,100},0,.9f};
  auto first=tracker.update({high});
  assert(first.size()==1);
  int id=first[0].track_id;
  Object low=high;low.prob=.2f;low.rect.x+=2;
  auto recovered=tracker.update({low});
  assert(recovered.size()==1 && recovered[0].track_id==id);
  Object newcomer{{400,100,50,100},0,.2f};
  auto with_low=tracker.update({high,newcomer});
  assert(with_low.size()==1 && with_low[0].track_id==id);
  assert(tracker.update({}).empty());
  auto after_gap=tracker.update({high});
  assert(after_gap.size()==1 && after_gap[0].track_id==id);
  for(int i=0;i<40;++i)tracker.update({});
  tracker.update({high}); // A late track requires confirmation.
  auto fresh=tracker.update({high});
  assert(fresh.size()==1 && fresh[0].track_id!=id);
  std::cout<<"pinned official ByteTrack: low-score recovery, births, loss, expiry PASS\n";
}

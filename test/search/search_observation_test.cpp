// Pure scheduler metadata. No media, BPU, HTTP or configuration writes.
#include "output/search_observation.hpp"
#include <iostream>
#include <stdexcept>
using namespace ai_service::output;
int checks=0;void Check(bool ok){++checks;if(!ok)throw std::runtime_error("observation continuity contract");}
int main(){try{
 SearchObservationClock clock;clock.Cadence(.1);
 auto previous=clock.Dispatch(100,100,.1);
 // Actual production input deltas at configured 10 FPS / 30 FPS source.
 const int steps[]={6,1,2,1,7,1,2,7,1,1,2,8,1,1,1,8,1,1,4,6,1,2,4};
 int raw=1;int slot=1;
 for(int step:steps){raw+=step;++slot;auto ticket=clock.Dispatch(100+slot*.1,100+slot*.1,.1);
   Check(AdjacentSearchObservations(previous,ticket));previous=ticket;}
 Check(raw==70);
 // A failed SDK dispatch already owns a slot: it cannot be hidden by numbering
 // only successful publications.
 const auto failed=clock.Dispatch(110,110,.1);(void)failed;
 auto next=clock.Dispatch(110.1,110.1,.1);Check(!AdjacentSearchObservations(previous,next));
 // Late whole slot = pressure: neighbouring dispatched slots stay adjacent (owner still bounds PTS/wall <= 1 s).
 previous=next;next=clock.Dispatch(110.4,110.2,.1);Check(AdjacentSearchObservations(previous,next));
 previous=next;clock.Gap(SearchObservationGapReason::Reset);next=clock.Dispatch(111,111,.1);Check(!AdjacentSearchObservations(previous,next));
 previous=next;clock.Cadence(.2);next=clock.Dispatch(112,112,.2);Check(!AdjacentSearchObservations(previous,next));
 {// Faults count as gaps, pressure counts as slips and never breaks adjacency.
  auto& c=SearchObservationCounters();
  const auto reset0=c.gaps[size_t(SearchObservationGapReason::Reset)].load();
  const auto late0=c.slips[size_t(SearchObservationGapReason::LateDeadline)].load();
  const auto lategap0=c.gaps[size_t(SearchObservationGapReason::LateDeadline)].load();
  const auto disp0=c.dispatched.load();
  SearchObservationClock probe;probe.Gap(SearchObservationGapReason::Reset);
  const auto a=probe.Dispatch(10,9.5,.1);
  probe.Slip(SearchObservationGapReason::ExpiredQueuedFrame);
  const auto b=probe.Dispatch(10.1,10.1,.1);
  Check(c.gaps[size_t(SearchObservationGapReason::Reset)].load()==reset0+1);
  Check(c.slips[size_t(SearchObservationGapReason::LateDeadline)].load()==late0+1);
  Check(c.gaps[size_t(SearchObservationGapReason::LateDeadline)].load()==lategap0);
  Check(AdjacentSearchObservations(a,b));
  Check(c.dispatched.load()==disp0+2);}
 Check(!AdjacentSearchObservations({},next));
 Check(!AdjacentSearchObservations({UINT64_MAX,1},{0,1}));
 std::cout<<checks<<" planned observation checks passed; no hardware executed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

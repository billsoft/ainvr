#include "../../ai-service/src/analytics/tracking_cadence.hpp"
#include <cassert>
#include <cmath>
using ai_service::analytics::TrackingCadence;
int main(){
 for(int fps:{3,5,10,15,30}){
  TrackingCadence c;double first=-1;
  for(int i=0;i<=fps*4;++i){double t=double(i)/fps;if(c.Observe(t,t)&&first<0)first=t;}
  assert(first>=2.0-1e-9 && first<=2.0+1.0/fps);
  // Both source-time slowdown and processing backpressure revoke eligibility.
  double t=4;for(int i=0;i<12;++i){t+=.5;c.Observe(t,t);}assert(!c.Observe(t+.5,t+.5));
  t+=.5;first=-1;double start=t;
  for(int i=1;i<=fps*4;++i){t=start+double(i)/fps;if(c.Observe(t,t)&&first<0)first=t-start;}
  assert(first>=0 && first<=2.0+1.0/fps);
  assert(!c.Observe(t+2,t+2));
 }
 TrackingCadence c;bool ready=false;
 for(int i=0;i<60;++i)ready=c.Observe(i*.1,i*.5);assert(!ready);
 c.Reset();double t=0;
 for(int fps:{30,3,15,5,10})for(int i=0;i<fps*4;++i){t+=1.0/fps;ready=c.Observe(t,t);if(t>2.34)assert(ready);}
 assert(ready);assert(!c.Observe(1,t+1));
 assert(!c.Observe(NAN,t));
}

#include "../../ai-service/src/stream/frame_copy_cadence.hpp"
#include <cassert>
int main(){
 ai_service::stream::FrameCopyCadence c;int kept=0;
 for(int i=0;i<300;i++)kept+=c.Keep(int64_t(i)*1000000000/30,6);
 assert(kept>=59&&kept<=60);
 assert(c.Keep(0,6));assert(c.Keep(1,0));assert(c.Keep(2,0));
 assert(c.Keep(3,10));assert(!c.Keep(4,10));assert(c.Keep(100000003,10));
 assert(c.Keep(0,10));
}

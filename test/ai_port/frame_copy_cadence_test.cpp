#include "../../ai-service/src/stream/frame_copy_cadence.hpp"
#include <cassert>
int main(){
 ai_service::stream::FrameCopyCadence c;int kept=0;
 for(int i=0;i<300;i++)kept+=c.Keep(int64_t(i)*1000000000/30,6);
 assert(kept>=59&&kept<=60);
 assert(c.Keep(0,6));assert(c.Keep(1,0));assert(c.Keep(2,0));
 assert(c.Keep(3,10));assert(!c.Keep(4,10));assert(c.Keep(100000003,10));
 assert(c.Keep(0,10));
 // Low-rate reference pictures are spaced by 100 ms. Fractional demand must
 // preserve average cadence and a bounded source-time gap.
 for(double target:{4.0,4.2,5.0,6.0}){
  ai_service::stream::FrameCopyCadence fractional;int count=0;int64_t last=-1,max_gap=0;
  for(int i=0;i<1000;i++)if(fractional.Keep(int64_t(i)*100000000,target)){
   if(last>=0)max_gap=std::max(max_gap,int64_t(i)*100000000-last);
   last=int64_t(i)*100000000;++count;
  }
  assert(std::abs(count-target*100)<=1);assert(max_gap<=300000000);
 }
 // RTMP timestamps are whole milliseconds (33/34/33 ms). At a copy rate equal to
 // the source rate every frame must be kept; a frame a fraction of a millisecond
 // ahead of the ideal grid is not early (measured on .190: 1 in 3 frames lost).
 {ai_service::stream::FrameCopyCadence ms;int all=0;
  for(int i=0;i<300;i++)all+=ms.Keep(int64_t(i*1000/30)*1000000,30);
  assert(all==300);
  ai_service::stream::FrameCopyCadence half;int kept15=0;
  for(int i=0;i<300;i++)kept15+=half.Keep(int64_t(i*1000/30)*1000000,15);
  assert(kept15>=149&&kept15<=151);}
 ai_service::stream::FrameCopyCadence stall;
 assert(stall.Keep(0,4));assert(stall.Keep(1000000000000LL,4));
 assert(!stall.Keep(1000000000001LL,4));assert(stall.Keep(1000250000000LL,4));}

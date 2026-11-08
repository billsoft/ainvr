#pragma once
#include <cmath>
#include <cstdint>
namespace ai_service::stream {
class FrameCopyCadence {
 public:
 bool Keep(int64_t pts,double rate){
  if(!std::isfinite(rate)||rate<=0){last_=-1;rate_=0;return true;}
  if(last_<0||rate!=rate_||pts<=last_){last_=pts;rate_=rate;return true;}
  if(double(pts-last_)+1>=1e9/rate){last_=pts;return true;}
  return false;
 }
 private:int64_t last_=-1;double rate_=0;
};
}

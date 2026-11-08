// AINVR. Conservative H.264 access-unit admission; never drop reference/state NALs.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <span>
#include <string_view>
#include <stdexcept>
#include <vector>
namespace ai_service::stream {
inline bool ReferenceDecodeEnabled(const char* setting) {
 if(!setting||std::string_view(setting)=="0")return false;
 if(std::string_view(setting)=="1")return true;
 throw std::invalid_argument("AINVR_AI_REFERENCE_DECODE must be 0 or 1");
}

// Only per-picture timing and user-data SEI can travel with a skipped picture.
// Buffering period, recovery, parameter/state changes and unknown SEI are kept.
inline bool DiscardablePictureSei(std::span<const uint8_t> ebsp) {
  if(ebsp.empty()||ebsp.size()>65536)return false;
  std::vector<uint8_t> rbsp;rbsp.reserve(ebsp.size());
  for(size_t i=0;i<ebsp.size();++i) {
    if(i>=2&&ebsp[i]==3&&ebsp[i-1]==0&&ebsp[i-2]==0) {
      if(i+1==ebsp.size()||ebsp[i+1]>3)return false;
      continue;
    }
    rbsp.push_back(ebsp[i]);
  }
  size_t i=0;bool seen=false;
  while(i<rbsp.size()) {
    if(rbsp[i]==0x80&&std::all_of(rbsp.begin()+i+1,rbsp.end(),[](uint8_t b){return b==0;}))return seen;
    size_t type=0,size=0;uint8_t b;
    do {if(i==rbsp.size())return false;b=rbsp[i++];type+=b;}while(b==255);
    do {if(i==rbsp.size())return false;b=rbsp[i++];size+=b;}while(b==255);
    if((type!=1&&type!=5)||size>rbsp.size()-i||(type==5&&size<16))return false;
    i+=size;seen=true;
  }
  return false;
}
inline bool DiscardableH264Picture(std::span<const uint8_t> bytes) {
  auto prefix=[&](size_t i)->size_t {
    if(i+3<=bytes.size()&&bytes[i]==0&&bytes[i+1]==0) {
      if(bytes[i+2]==1)return 3;
      if(i+4<=bytes.size()&&bytes[i+2]==0&&bytes[i+3]==1)return 4;
    }
    return 0;
  };
  size_t pos=0;bool slice=false;
  while(pos<bytes.size()) {
    const auto n=prefix(pos);if(!n)return false;
    const auto start=pos+n;if(start>=bytes.size())return false;
    size_t end=start+1;while(end<bytes.size()&&!prefix(end))++end;
    const uint8_t header=bytes[start];if(header&0x80)return false;
    const auto type=header&31,reference=(header>>5)&3;
    if(type==1) {if(reference||end-start<2)return false;slice=true;}
    else if(type==6) {if(reference||!DiscardablePictureSei(bytes.subspan(start+1,end-start-1)))return false;}
    else if((type!=9&&type!=12)||reference)return false;
    // In particular SPS/PPS/stateful SEI/extensions and all unknown layouts are kept.
    pos=end;
  }
  return slice;
}
class ReferenceDecodeCadence {
 public:
  bool Drop(int64_t dts,double rate,bool discardable) {
    if(!std::isfinite(rate)||rate<=0||rate>10||dts<0){last_=-1;return false;}
    const bool due=last_<0||dts<=last_||double(dts-last_)+1>=1e9/rate;
    if(discardable&&!due)return true;
    last_=dts;return false;
  }
 private:int64_t last_=-1;
};
}

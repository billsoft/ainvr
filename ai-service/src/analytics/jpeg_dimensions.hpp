// Existing shared metadata parser; no image decoding or CPU pixel processing.
#pragma once
#include <cstdint>
#include <stdexcept>
#include <utility>
#include <vector>
namespace ai_service::analytics {
inline std::pair<int,int> JpegDimensions(const std::vector<uint8_t>& bytes) {
  if(bytes.size()<4||bytes.size()>16U*1024*1024||bytes[0]!=255||bytes[1]!=216)
    throw std::invalid_argument("Invalid review JPEG");
  size_t p=2;
  while(p<bytes.size()) {
    if(bytes[p++]!=255)throw std::invalid_argument("Invalid JPEG marker");
    while(p<bytes.size()&&bytes[p]==255)++p;
    if(p>=bytes.size())break;
    const auto marker=bytes[p++];
    if(marker==0xda||marker==0xd9)break;
    if(marker==0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(p+2>bytes.size())break;
    const size_t length=(size_t(bytes[p])<<8)|bytes[p+1];
    if(length<2||length>bytes.size()-p)throw std::invalid_argument("Truncated JPEG segment");
    if(marker==0xc0||marker==0xc1||marker==0xc2) {
      if(length<8||bytes[p+2]!=8)throw std::invalid_argument("Unsupported JPEG precision");
      const int h=(int(bytes[p+3])<<8)|bytes[p+4],w=(int(bytes[p+5])<<8)|bytes[p+6];
      if(w<1||h<1||w>8192||h>8192)throw std::invalid_argument("Invalid JPEG dimensions");
      return {w,h};
    }
    p+=length;
  }
  throw std::invalid_argument("JPEG has no supported frame header");
}
} // namespace ai_service::analytics

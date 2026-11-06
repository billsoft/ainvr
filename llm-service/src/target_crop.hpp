#pragma once
#include <array>
#include <vector>
#include <cmath>
#include <algorithm>
#include <stdexcept>
namespace ainvr {
// Preserve the target centre even at image edges. Focused views fit their own
// aspect ratio to the canvas; padding must never expose adjacent scene pixels.
inline std::array<float,4> TargetCrop(const std::array<float,4>& box,int width,int height,bool focused,float expansion=1.15f) {
  if(width<=0||height<=0||!std::isfinite(expansion)||expansion<1||expansion>2)
    throw std::invalid_argument("invalid target crop dimensions");
  for(float v:box)if(!std::isfinite(v)||v<0||v>1)throw std::invalid_argument("invalid target crop box");
  if(box[2]<=box[0]||box[3]<=box[1])throw std::invalid_argument("empty target crop box");
  float w=(box[2]-box[0])*width*(focused?expansion:1.5f);
  float h=(box[3]-box[1])*height*(focused?expansion:1.5f);
  if(!focused){w=std::max(w,2*h);h=w/2;}
  return {(box[0]+box[2])*width/2-w/2,(box[1]+box[3])*height/2-h/2,w,h};
}
inline std::array<float,4> TargetCanvas(const std::array<float,4>& box,int width,int height,float expansion) {
  const auto crop=TargetCrop(box,width,height,true,expansion);
  const float scale=std::min(896.f/crop[2],448.f/crop[3]);
  const float halfw=(box[2]-box[0])*width*scale/2;
  const float halfh=(box[3]-box[1])*height*scale/2;
  return {(.5f*896-halfw)/896,(.5f*448-halfh)/448,(.5f*896+halfw)/896,(.5f*448+halfh)/448};
}

inline std::vector<std::array<float,2>> RegionCanvas(const std::vector<std::array<float,2>>& region,const std::array<float,4>& box,int width,int height,float expansion) {
  const auto crop=TargetCrop(box,width,height,true,expansion);
  const float scale=std::min(896.f/crop[2],448.f/crop[3]);
  std::vector<std::array<float,2>> result;
  for(const auto& p:region)result.push_back({((896-crop[2]*scale)/2+(p[0]*width-crop[0])*scale)/896,((448-crop[3]*scale)/2+(p[1]*height-crop[1])*scale)/448});
  return result; // Out-of-crop points stay outside; never deform the real zone.
}

inline std::array<float,4> VisibleCanvas(const std::array<float,4>& box,int width,int height,float expansion) {
 const auto crop=TargetCrop(box,width,height,true,expansion);
 const float scale=std::min(896.f/crop[2],448.f/crop[3]);
 const float left=(896-crop[2]*scale)/2,top=(448-crop[3]*scale)/2;
 return {(left+(std::max(0.f,crop[0])-crop[0])*scale)/896,(top+(std::max(0.f,crop[1])-crop[1])*scale)/448,
 (left+(std::min(float(width),crop[0]+crop[2])-crop[0])*scale)/896,(top+(std::min(float(height),crop[1]+crop[3])-crop[1])*scale)/448};
}

}

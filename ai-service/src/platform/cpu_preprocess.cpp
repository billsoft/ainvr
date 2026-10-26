// Copyright AINVR.
#include "cpu_preprocess.hpp"
#include <algorithm>
#include <cmath>
#include <numbers>
#include <stdexcept>
namespace ainvr {
void ValidateTransform(const Nv12Frame& f,const ImageTransform& t){
  ValidateSourceRegion(t);
  if(f.width<=0||f.height<=0||f.width>16384||f.height>16384||f.width%2||f.height%2||
     f.pixels.size()!=size_t(f.width)*f.height*3/2||t.width<=0||t.height<=0||t.width>8192||t.height>8192)
    throw std::invalid_argument("Invalid NV12 input or output dimensions");
  for(int i=0;i<3;++i)if(!std::isfinite(t.mean[i])||!std::isfinite(t.divisor[i])||t.divisor[i]==0||!std::isfinite(t.padding[i]))
    throw std::invalid_argument("Invalid normalization");
  if(t.erp_perspective&&(!std::isfinite(t.yaw)||!std::isfinite(t.pitch)||!(t.horizontal_fov>0&&t.horizontal_fov<std::numbers::pi)))
    throw std::invalid_argument("Invalid ERP perspective parameters");
  double ratio=std::min(double(t.width)/f.width,double(t.height)/f.height);
  if(t.letterbox&&!t.erp_perspective&&(std::nearbyint(f.width*ratio)<1||std::nearbyint(f.height*ratio)<1))
    throw std::invalid_argument("Letterbox dimension rounds to zero");
  ValidateInterpolation(t,f.width,f.height);
}
namespace {
float Sample(const uint8_t* data,int w,int h,int channels,int channel,double u,double v,bool nearest,bool wrap){
  auto pixel=[&](int x,int y){x=wrap?(x%w+w)%w:std::clamp(x,0,w-1);y=std::clamp(y,0,h-1);return float(data[(size_t(y)*w+x)*channels+channel]);};
  if(nearest)return pixel(int(std::floor(u*w)),int(std::floor(v*h)));
  double x=u*w-.5,y=v*h-.5;int ix=int(std::floor(x)),iy=int(std::floor(y));float fx=x-ix,fy=y-iy;
  return std::lerp(std::lerp(pixel(ix,iy),pixel(ix+1,iy),fx),std::lerp(pixel(ix,iy+1),pixel(ix+1,iy+1),fx),fy);
}
}
std::vector<float> CpuPreprocess(const Nv12Frame& input,const ImageTransform& t){
  if(t.interpolation!=ImageInterpolation::Bilinear)
    throw std::invalid_argument("This CPU test oracle does not implement the requested GPU resize filter");
  ValidateTransform(input,t);int w=input.width,h=input.height,nw=t.width,nh=t.height;
  if(t.letterbox&&!t.erp_perspective){double scale=std::min(double(nw)/w,double(nh)/h);nw=std::nearbyint(w*scale);nh=std::nearbyint(h*scale);}
  int left=(t.width-nw)/2,top=(t.height-nh)/2;size_t area=size_t(t.width)*t.height;
  std::vector<float> result(area*3);const uint8_t* chroma=input.pixels.data()+size_t(w)*h;
  double tangent=std::tan(t.horizontal_fov/2.),cp=std::cos(t.pitch),sp=std::sin(t.pitch),cy=std::cos(t.yaw),sy=std::sin(t.yaw);
  for(int y=0;y<t.height;++y)for(int x=0;x<t.width;++x){
    double u=(x+.5-left)/nw,v=(y+.5-top)/nh;
    if(t.erp_perspective){
      double dx=((x+.5)/t.width*2-1)*tangent,dy=-((y+.5)/t.height*2-1)*tangent*t.height/t.width;
      double length=std::sqrt(dx*dx+dy*dy+1),dz=1/length;dx/=length;dy/=length;
      double py=cp*dy+sp*dz,pz=-sp*dy+cp*dz;
      u=std::atan2(cy*dx+sy*pz,-sy*dx+cy*pz)/(2*std::numbers::pi)+.5;
      v=.5-std::asin(std::clamp(py,-1.,1.))/std::numbers::pi;
    }
    std::array<float,3> rgb=t.padding;
    if(t.erp_perspective||(u>=0&&u<1&&v>=0&&v<1)){
      if(t.source_region){const auto& r=*t.source_region;u=(r[0]+u*r[2])/w;v=(r[1]+v*r[3])/h;}
      if(!t.source_region_padding||(u>=0&&u<1&&v>=0&&v<1)){
      float yy=Sample(input.pixels.data(),w,h,1,0,u,v,t.nearest,t.erp_perspective);
      float uu=Sample(chroma,w/2,h/2,2,0,u,v,t.nearest,t.erp_perspective)-128;
      float vv=Sample(chroma,w/2,h/2,2,1,u,v,t.nearest,t.erp_perspective)-128;
      if(!t.yuv_full_range){yy=(yy-16)*255/219;uu*=255.f/224;vv*=255.f/224;}
      rgb={yy+(t.yuv_bt709?1.5748f:1.402f)*vv,
           yy-(t.yuv_bt709?.187324f:.344136f)*uu-(t.yuv_bt709?.468124f:.714136f)*vv,
           yy+(t.yuv_bt709?1.8556f:1.772f)*uu};
      for(float& c:rgb)c=std::clamp(c,0.f,255.f);
      }
    }
    if(t.bgr)std::swap(rgb[0],rgb[2]);
    for(int c=0;c<3;++c)result[size_t(c)*area+size_t(y)*t.width+x]=(rgb[c]-t.mean[c])/t.divisor[c];
  }
  return result;
}
}

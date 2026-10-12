// Copyright AINVR. Geometry port of the read-only reference snapshot behavior.
#include "snapshot_plan.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace ainvr {
namespace {
constexpr double pi=3.14159265358979323846;
int Round(double value){return std::max(1,int(std::nearbyint(value)));}
}
std::optional<SnapshotPlan> PlanSnapshot(const std::array<double,4>& b,int sw,int sh,
    const ai_service::config::SnapshotConfig& cfg,bool square){
  if(sw<=0||sh<=0||sw>8192||sh>8192||cfg.max_crop_dimension<=0||cfg.max_crop_dimension>8192||
     !std::isfinite(cfg.padding_ratio)||cfg.padding_ratio<0||cfg.padding_ratio>1||
     (cfg.projection_mode!="none"&&cfg.projection_mode!="erp_equirect"))
    throw std::invalid_argument("Invalid snapshot geometry configuration");
  if(!std::all_of(b.begin(),b.end(),[](double x){return std::isfinite(x)&&std::abs(x)<=32760;})||b[2]<=0||b[3]<=0)
    return std::nullopt;
  SnapshotPlan p;double x=b[0],y=b[1],w=b[2],h=b[3],margin=1+2*cfg.padding_ratio;
  p.center_x=x+w/2;p.center_y=y+h/2;
  auto size=[&](double ow,double oh){
    double scale=std::min(1.,cfg.max_crop_dimension/std::max(ow,oh));
    p.width=Round(ow*scale);p.height=Round(oh*scale);
  };
  if(cfg.projection_mode=="none"){
    if(square){
      double side=std::max(w,h)*margin;
      int n=Round(side);double left=std::nearbyint(p.center_x-side/2),top=std::nearbyint(p.center_y-side/2);
      if(std::min(double(sw),left+n)<=std::max(0.,left)||std::min(double(sh),top+n)<=std::max(0.,top))return std::nullopt;
      p.source_rectangle={left,top,double(n),double(n)};p.replicate_edges=true;size(n,n);
    }else{
      double left=std::floor(std::max(0.,x-w*cfg.padding_ratio));
      double top=std::floor(std::max(0.,y-h*cfg.padding_ratio));
      double right=std::ceil(std::min(double(sw),x+w+w*cfg.padding_ratio));
      double bottom=std::ceil(std::min(double(sh),y+h+h*cfg.padding_ratio));
      if(right<=left||bottom<=top)return std::nullopt;
      p.source_rectangle={left,top,right-left,bottom-top};size(right-left,bottom-top);
    }
    return p;
  }
  p.perspective=true;p.yaw=(p.center_x/sw-.5)*2*pi;p.pitch=(.5-p.center_y/sh)*pi;
  double half_x=0,half_y=0;int valid=0;
  auto sample=[&](double px,double py){
    double longitude=(px/sw-.5)*2*pi,latitude=(.5-py/sh)*pi;
    double wx=std::cos(latitude)*std::sin(longitude),wy=std::sin(latitude),wz=std::cos(latitude)*std::cos(longitude);
    double lx=std::cos(p.yaw)*wx-std::sin(p.yaw)*wz;
    double z=std::sin(p.yaw)*wx+std::cos(p.yaw)*wz;
    double ly=std::cos(p.pitch)*wy-std::sin(p.pitch)*z;
    double lz=std::sin(p.pitch)*wy+std::cos(p.pitch)*z;
    if(lz<=1e-9)return;
    ++valid;half_x=std::max(half_x,std::abs(lx/lz));half_y=std::max(half_y,std::abs(ly/lz));
  };
  for(int i=0;i<9;++i){double t=i/8.;sample(x+t*w,y);sample(x+t*w,y+h);sample(x,y+t*h);sample(x+w,y+t*h);}
  if(valid<4||half_x<=1e-12||half_y<=1e-12){
    double ow=w*margin,oh=h*margin;if(square)ow=oh=std::max(ow,oh);
    p.horizontal_fov=std::clamp(ow/sw*360.,1.,170.)*pi/180;size(ow,oh);return p;
  }
  double mx=half_x*margin,my=half_y*margin;if(square)mx=my=std::max(mx,my);
  p.horizontal_fov=std::clamp(2*std::atan(mx)*180/pi,1.,170.)*pi/180;
  double k=std::min(w/(2*half_x),h/(2*half_y));double ow=2*mx*k,oh=2*my*k;
  if(std::min(ow,oh)<16){double factor=16/std::min(ow,oh);ow*=factor;oh*=factor;}
  size(ow,oh);return p;
}
}

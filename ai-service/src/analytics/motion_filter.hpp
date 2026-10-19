// Copyright AINVR. Constant-velocity Kalman filter in source-time seconds.
// Four independent (position,velocity) blocks represent center x/y, aspect, height.
// Predictions are association aids, never observed detections.
#pragma once
#include <array>
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace ai_service::analytics {
class MotionFilter {
 public:
  using Rectangle=std::array<double,4>;
  void Initialize(const Rectangle& box) {
    const auto z=Measurement(box);
    for(size_t i=0;i<4;++i) {
      double scale=i==2?0.1:std::max(z[3],1e-6);
      axes_[i]={z[i],0,scale*scale*0.01,0,scale*scale};
    }
    initialized_=true;
  }
  void Predict(double seconds) {
    Require();
    if(!std::isfinite(seconds)||seconds<0||seconds>60) throw std::invalid_argument("Invalid motion interval");
    const double height=std::max(std::abs(axes_[3].position),1e-6);
    for(size_t i=0;i<4;++i) {
      auto& a=axes_[i];
      const double scale=i==2?0.01:height*0.1;
      const double q=scale*scale,t=seconds;
      a.position+=t*a.velocity;
      a.pp+=2*t*a.pv+t*t*a.vv+q*t*t*t/3;
      a.pv+=t*a.vv+q*t*t/2;
      a.vv+=q*t;
    }
  }
  void Correct(const Rectangle& box) {
    Require();
    auto z=Measurement(box);
    for(size_t i=0;i<4;++i) {
      auto& a=axes_[i];
      const double noise=i==2?0.01:std::max(z[3]*0.05,1e-6);
      const double r=noise*noise;
      const double innovation=z[i]-a.position,s=a.pp+r;
      const double k0=a.pp/s,k1=a.pv/s;
      a.position+=k0*innovation;a.velocity+=k1*innovation;
      // Joseph covariance update maintains positive semidefiniteness.
      const double pp=a.pp,pv=a.pv,vv=a.vv;
      a.pp=(1-k0)*(1-k0)*pp+k0*k0*r;
      a.pv=(1-k0)*(pv-k1*pp)+k0*k1*r;
      a.vv=vv-2*k1*pv+k1*k1*pp+k1*k1*r;
    }
  }
  Rectangle PredictedBox() const {
    Require();
    const double h=std::max(axes_[3].position,1e-6);
    const double w=std::max(axes_[2].position,1e-6)*h;
    return {axes_[0].position-w/2,axes_[1].position-h/2,w,h};
  }
  std::array<double,2> Velocity() const {Require();return {axes_[0].velocity,axes_[1].velocity};}
  std::array<double,4> PositionVariance() const {
    Require();return {axes_[0].pp,axes_[1].pp,axes_[2].pp,axes_[3].pp};
  }
 private:
  struct Axis {double position=0,velocity=0,pp=0,pv=0,vv=0;};
  std::array<Axis,4> axes_{};
  bool initialized_=false;
  void Require() const {if(!initialized_)throw std::logic_error("Motion filter not initialized");}
  static Rectangle Measurement(Rectangle b) {
    for(double v:b) if(!std::isfinite(v))throw std::invalid_argument("Nonfinite motion observation");
    if(b[2]<=0||b[3]<=0)throw std::invalid_argument("Empty motion observation");
    return {b[0]+b[2]/2,b[1]+b[3]/2,b[2]/b[3],b[3]};
  }
};
}

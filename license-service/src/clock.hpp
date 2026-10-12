#pragma once
#include <cstdint>
#include <string>
namespace ainvr_license {
class Clock {
 public:
  virtual ~Clock()=default;
  virtual int64_t WallSec()=0;
  virtual int64_t MonoNs()=0;
  virtual int64_t BootNs(){return MonoNs();}
  virtual std::string BootId()=0;
};
class SystemClock:public Clock {
 public:
  int64_t WallSec()override;
  int64_t MonoNs()override;
  int64_t BootNs()override;
  std::string BootId()override;
};
class FakeClock:public Clock {
 public:
  FakeClock(int64_t w,int64_t m,std::string b):wall_(w),mono_(m),boot_ns_(m),boot_(std::move(b)){}
  int64_t WallSec()override{return wall_;}
  int64_t MonoNs()override{return mono_;}
  int64_t BootNs()override{return boot_ns_;}
  std::string BootId()override{return boot_;}
  void SetWall(int64_t v){wall_=v;}
  void SetMono(int64_t v){mono_=v;boot_ns_=v;}
  void SetBoot(std::string v){boot_=std::move(v);}
  void AdvanceWall(int64_t v){wall_+=v;}
  void AdvanceMonoSec(int64_t v){mono_+=v*1000000000LL;boot_ns_+=v*1000000000LL;}
  void AdvanceNs(int64_t v){mono_+=v;boot_ns_+=v;}
  void Suspend(int64_t v){boot_ns_+=v*1000000000LL;}
  void AdvanceNormal(int64_t v){AdvanceWall(v);AdvanceMonoSec(v);}
 private:
  int64_t wall_,mono_,boot_ns_;
  std::string boot_;
};
}

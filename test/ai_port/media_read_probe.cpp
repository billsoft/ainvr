// Copyright AINVR. Bounded demux-only diagnostic; no decoder or inference.
#include "stream/media_source.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
int main(int argc,char** argv) {
  try {
    if(argc!=3)throw std::runtime_error("usage: media_read_probe SOURCE SECONDS");
    const int seconds=std::stoi(argv[2]);
    if(seconds<1||seconds>60)throw std::runtime_error("duration outside 1..60");
    using Clock=std::chrono::steady_clock;
    const auto start=Clock::now();
    ainvr::MediaSource source(argv[1],2000);
    const auto opened=Clock::now();
    unsigned count=0; uint64_t bytes=0;
    auto last=opened; unsigned previous=0;
    while(Clock::now()-opened<std::chrono::seconds(seconds)) {
      auto frame=source.Read(); if(!frame)break;
      ++count; bytes+=frame->bytes.size();
      const auto now=Clock::now();
      if(now-last>=std::chrono::seconds(1)) {
        std::cout<<"sample "<<std::chrono::duration<double>(now-opened).count()
                 <<" "<<count<<" "<<(count-previous)/std::chrono::duration<double>(now-last).count()<<std::endl;
        previous=count;last=now;
      }
    }
    std::cout<<"total "<<count<<" bytes "<<bytes<<" elapsed "
             <<std::chrono::duration<double>(Clock::now()-opened).count()
             <<" open_ms "<<std::chrono::duration<double,std::milli>(opened-start).count()<<std::endl;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}

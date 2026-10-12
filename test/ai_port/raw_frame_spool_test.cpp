// Copyright AINVR. Separate-process recovery of a real-sized 8K NV12 task.
#include "output/raw_frame_spool.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>
void Require(bool b){if(!b)throw std::runtime_error("Raw frame spool assertion failed");}
int main(int argc,char**argv){try{
 if(argc!=2)throw std::runtime_error("Fresh output directory required");
 std::filesystem::path path=argv[1];Require(!std::filesystem::exists(path));
 ainvr::RawFrameTask task;task.frame.width=7680;task.frame.height=3840;task.frame.pts=9007199254740993ULL;
 task.frame.pixels.resize(size_t(7680)*3840*3/2);for(size_t i=0;i<task.frame.pixels.size();++i)task.frame.pixels[i]=uint8_t(i*17+i/31);
 task.metadata={{"version",1},{"frame_pts_ns",9007199254740993LL},{"detection_ids",{"507f1f77bcf86cd799439019"}}};
 const std::string id="507f1f77bcf86cd799439011",other="507f1f77bcf86cd799439012";
 auto child=fork();Require(child>=0);
 if(!child){try{ainvr::RawFrameSpool spool(path.string(),100*1024*1024);spool.Stage(id,task);std::_Exit(23);}catch(...){std::_Exit(1);}}
 int status=0;Require(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==23);
 {
  ainvr::RawFrameSpool spool(path.string(),100*1024*1024);Require(spool.Pending()==std::vector<std::string>{id});
  spool.Stage(id,task);Require(spool.Pending().size()==1);
  bool failed=false;try{spool.Deliver(id,[](auto&){throw std::runtime_error("render failure");});}catch(...){failed=true;}
  Require(failed&&spool.Pending().size()==1);
  spool.Stage(other,task);failed=false;try{spool.Stage("507f1f77bcf86cd799439013",task);}catch(...){failed=true;}
  Require(failed&&spool.Pending().size()==2);
  auto expected=task.frame.pixels[0];task.frame.pixels[0]^=1;failed=false;
  try{spool.Stage(id,task);}catch(...){failed=true;}Require(failed);task.frame.pixels[0]=expected;
  spool.Deliver(id,[&](const auto&got){Require(got.frame.pixels==task.frame.pixels&&got.frame.pts==task.frame.pts&&got.metadata==task.metadata);});
  Require(spool.Pending()==std::vector<std::string>{other});
 }
 auto pending=path/(other+".pending");
 {std::fstream file(pending,std::ios::in|std::ios::out|std::ios::binary);file.seekp(100);file.put(char(0xff));}
 bool failed=false;try{ainvr::RawFrameSpool spool(path.string(),100*1024*1024);}catch(...){failed=true;}
 Require(failed&&std::filesystem::exists(pending));
 std::cout<<"PASS 7680x3840, process exit recovery, exact 64-bit PTS, retry, backpressure, corruption retention\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}

// Copyright AINVR. Actual OS concurrency/lifetime control; no neural calls.
#include "platform/locateanything_channel_lease.hpp"
#include <sys/wait.h>
#include <atomic>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
using ainvr::LocateAnythingChannelLease;
void require(bool x,const char* message){if(!x)throw std::runtime_error(message);}
bool busy(const std::string& p){
  try{LocateAnythingChannelLease lease(p);return false;}
  catch(const std::runtime_error& e){return std::string(e.what())==LocateAnythingChannelLease::kBusy;}
}
int main(){
 try{
  const auto dir=std::filesystem::path("/home/sunrise/ainvr/test/tmp")/("locate-lease-"+std::to_string(getpid()));
  require(!std::filesystem::exists(dir),"temporary directory exists");std::filesystem::create_directory(dir);
  const auto p=(dir/"owner.lock").string();
  {
   LocateAnythingChannelLease owner(p);require(busy(p),"same-process second owner admitted");
   const pid_t child=fork();require(child>=0,"fork failed");
   if(child==0)_exit(busy(p)?0:3);
   int status=0;require(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0,"cross-process owner admitted");
  }
  require(std::filesystem::exists(p),"lock inode was unlinked");
  {LocateAnythingChannelLease successor(p);require(busy(p),"successor does not own lease");}
  // Unwinding an initialization failure must release the lock.
  try{LocateAnythingChannelLease failed(p);throw std::runtime_error("simulated load failure");}catch(const std::runtime_error&){}
  {LocateAnythingChannelLease recovered(p);}
  // All contenders attempt once while the winner deliberately retains its lease.
  constexpr int count=12;std::mutex mu;std::condition_variable cv;bool go=false;int attempted=0;
  std::atomic<int> admitted{0},rejected{0},unexpected{0};std::vector<std::thread> threads;
  for(int i=0;i<count;++i)threads.emplace_back([&]{
   {std::unique_lock lock(mu);cv.wait(lock,[&]{return go;});}
   std::unique_ptr<LocateAnythingChannelLease> lease;
   try{lease=std::make_unique<LocateAnythingChannelLease>(p);++admitted;}
   catch(const std::runtime_error& e){if(std::string(e.what())==LocateAnythingChannelLease::kBusy)++rejected;else ++unexpected;}
   {std::unique_lock lock(mu);++attempted;cv.notify_all();if(lease)cv.wait(lock,[&]{return attempted==count;});}
  });
  {std::lock_guard lock(mu);go=true;}cv.notify_all();for(auto& t:threads)t.join();
  require(admitted==1 && rejected==count-1 && unexpected==0,"simultaneous channel exclusion failed");
  {LocateAnythingChannelLease released(p);}
  const auto alias=dir/"alias.lock";std::filesystem::create_symlink(p,alias);
  bool symlink=false;try{LocateAnythingChannelLease invalid(alias);}catch(const std::runtime_error&){symlink=true;}
  require(symlink,"symlink lock accepted");
  const auto exposed=dir/"exposed.lock";{std::ofstream f(exposed);f<<"control";}chmod(exposed.c_str(),0666);
  bool permissions=false;try{LocateAnythingChannelLease invalid(exposed);}catch(const std::runtime_error&){permissions=true;}
  require(permissions,"public lock permissions accepted");
  // File remains empty: no identity,token or credential is persisted.
  require(std::filesystem::file_size(p)==0,"lease wrote persistent payload");
  std::filesystem::remove(alias);std::filesystem::remove(exposed);std::filesystem::remove(p);std::filesystem::remove(dir);
  std::cout<<"{\"status\":\"completed\",\"same_process_exclusion\":true,\"cross_process_exclusion\":true,\"simultaneous_contenders\":12,\"simultaneous_admitted\":1,\"release_and_reacquire\":true,\"load_failure_unwind\":true,\"symlink_rejected\":true,\"insecure_permissions_rejected\":true,\"neural_calls\":0}\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}

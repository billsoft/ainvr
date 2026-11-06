#define AINVR_FAKE_SDK_LIBRARY
#include "../../../test/ai_port/bpu_timeout_control_test.cpp"
#include <filesystem>
#include <fstream>
#include <future>
#include <fcntl.h>
#include "platform/model_digest.hpp"
#include <unistd.h>
#define VERIFY(condition) do { if(!(condition))throw std::runtime_error("shared BPU assertion line "+std::to_string(__LINE__)); } while(false)
int main(){try{
 const auto dir=std::filesystem::path(std::getenv("TMPDIR")?std::getenv("TMPDIR"):"/tmp")/("ainvr-shared-test-"+std::to_string(getpid()));
 std::filesystem::create_directories(dir);auto path=dir/"model.hbm";{std::ofstream f(path);f<<"fake content one";}
 std::filesystem::create_symlink(path,dir/"alias.hbm");
 std::this_thread::sleep_for(std::chrono::milliseconds(2100));
 auto one=ainvr::BpuModel::Acquire(path.string()),two=ainvr::BpuModel::Acquire((dir/"alias.hbm").string());VERIFY(one==two&&loads==1);
 auto digestStatus=ainvr::BpuModel::SharedStatus()["digest_cache"];
 VERIFY(digestStatus["misses"]==1&&digestStatus["hits"]==1);
 std::vector<std::future<std::shared_ptr<ainvr::BpuModel>>> acquire;
 for(int i=0;i<16;++i)acquire.push_back(std::async(std::launch::async,[&]{return ainvr::BpuModel::Acquire(path.string());}));
 for(auto& request:acquire)VERIFY(request.get()==one);
 VERIFY(loads==1&&ainvr::BpuModel::SharedStatus()["digest_cache"]["misses"]==1);
 std::vector<std::future<void>> jobs;
 for(int i=1;i<=32;++i)jobs.push_back(std::async(std::launch::async,[&,i]{for(int n=0;n<10;++n){std::vector<unsigned char> input(4,static_cast<unsigned char>(i));auto output=(i%2?one:two)->Run({input});VERIFY(output.at(0)==input);}}));
 for(auto& job:jobs)job.get();
 bool rejected=false;try{one->Run({{1}});}catch(...){rejected=true;}VERIFY(rejected);VERIFY(two->Run({{1,2,3,4}})[0][3]==4);
 one.reset();VERIFY(unloads==0);two.reset();VERIFY(unloads==1&&frees==2);VERIFY(ainvr::BpuModel::SharedStatus()["instances"]==0);
 auto v1=ainvr::BpuModel::Acquire(path.string());{std::ofstream f(path);f<<"fake content two";}auto v2=ainvr::BpuModel::Acquire(path.string());VERIFY(v1!=v2&&loads==3);v1.reset();v2.reset();
 // Descriptor identity, concurrent cold access, ctime invalidation and atomic replacement.
 std::this_thread::sleep_for(std::chrono::milliseconds(2100));
 ainvr::ModelDigestCache digests;
 int fd=open(path.c_str(),O_RDONLY|O_CLOEXEC);VERIFY(fd>=0);
 std::vector<std::future<std::string>> hashes;
 for(int i=0;i<12;++i)hashes.push_back(std::async(std::launch::async,[&]{return digests.Get(fd);}));
 const auto original=hashes.front().get();for(size_t i=1;i<hashes.size();++i)VERIFY(hashes[i].get()==original);
 VERIFY(digests.Status().misses==1&&digests.Status().hits==11);
 struct stat saved{};VERIFY(fstat(fd,&saved)==0);
 {std::ofstream f(path);f<<"fake content six";}
 timespec times[2]={saved.st_atim,saved.st_mtim};VERIFY(utimensat(AT_FDCWD,path.c_str(),times,0)==0);
 const auto changed=digests.Get(fd);VERIFY(changed!=original&&digests.Status().misses==2);
 auto replacement=dir/"replacement";{std::ofstream f(replacement);f<<"replacement";}
 std::filesystem::rename(replacement,path);
 VERIFY(digests.Get(fd)==changed); // old descriptor stays bound to old inode
 int fresh=open(path.c_str(),O_RDONLY|O_CLOEXEC);VERIFY(fresh>=0);
 VERIFY(digests.Get(fresh)!=changed);close(fresh);
 for(int i=0;i<130;++i){auto item=dir/("evict-"+std::to_string(i));{std::ofstream f(item);f<<i;}
   int input=open(item.c_str(),O_RDONLY|O_CLOEXEC);VERIFY(input>=0);digests.Get(input);close(input);}
 const auto misses=digests.Status().misses;VERIFY(digests.Get(fd)==changed);VERIFY(digests.Status().misses==misses+1);close(fd);
 bool invalid=false;try{digests.Get(-1);}catch(...){invalid=true;}VERIFY(invalid);
 auto warm=ainvr::BpuModel::Acquire(path.string());
 auto coldPath=dir/"cold.hbm";{std::ofstream f(coldPath);f<<"separate cold model";}
 ainvr::SharedRetirementBarrier().Begin();
 auto warmAgain=ainvr::BpuModel::Acquire(path.string());VERIFY(warmAgain==warm);
 auto cold=std::async(std::launch::async,[&]{return ainvr::BpuModel::Acquire(coldPath.string());});
 const bool blocked=cold.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout;
 ainvr::SharedRetirementBarrier().End();
 VERIFY(blocked);auto loaded=cold.get();VERIFY(loaded!=warm);
 loaded.reset();warmAgain.reset();warm.reset();
 std::filesystem::remove_all(dir);std::cout<<"PASS shared model identity, one load, 320 isolated outputs, release and version replacement\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

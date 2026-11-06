#define AINVR_FAKE_SDK_LIBRARY
#include "../../../test/ai_port/bpu_timeout_control_test.cpp"
#include <filesystem>
#include <fstream>
#include <future>
#include <unistd.h>
int main(){try{
 const auto dir=std::filesystem::path(std::getenv("TMPDIR")?std::getenv("TMPDIR"):"/tmp")/("ainvr-shared-test-"+std::to_string(getpid()));
 std::filesystem::create_directories(dir);auto path=dir/"model.hbm";{std::ofstream f(path);f<<"fake content one";}
 std::filesystem::create_symlink(path,dir/"alias.hbm");
 auto one=ainvr::BpuModel::Acquire(path.string()),two=ainvr::BpuModel::Acquire((dir/"alias.hbm").string());Require(one==two&&loads==1);
 std::vector<std::future<void>> jobs;
 for(int i=1;i<=32;++i)jobs.push_back(std::async(std::launch::async,[&,i]{for(int n=0;n<10;++n){std::vector<unsigned char> input(4,static_cast<unsigned char>(i));auto output=(i%2?one:two)->Run({input});Require(output.at(0)==input);}}));
 for(auto& job:jobs)job.get();
 bool rejected=false;try{one->Run({{1}});}catch(...){rejected=true;}Require(rejected);Require(two->Run({{1,2,3,4}})[0][3]==4);
 one.reset();Require(unloads==0);two.reset();Require(unloads==1&&frees==2);Require(ainvr::BpuModel::SharedStatus()["instances"]==0);
 auto v1=ainvr::BpuModel::Acquire(path.string());{std::ofstream f(path);f<<"fake content two";}auto v2=ainvr::BpuModel::Acquire(path.string());Require(v1!=v2&&loads==3);v1.reset();v2.reset();
 std::filesystem::remove_all(dir);std::cout<<"PASS shared model identity, one load, 320 isolated outputs, release and version replacement\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

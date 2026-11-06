// Explicit hardware acceptance probe; synthetic input bytes are test data only.
#include "platform/bpu.hpp"
#include <fstream>
#include <sstream>
#include <future>
#include <iostream>
uint64_t Ion(){std::ifstream in("/sys/kernel/debug/ion/heaps/all_heap_info");std::string line;uint64_t sum=0;while(std::getline(in,line)){std::istringstream s(line);std::string first;uint64_t n;if(s>>first>>n&&first=="total")sum+=n;}return sum;}
int main(int argc,char** argv){try{
 if(argc!=2&&argc!=3)throw std::runtime_error("usage: bpu_shared_probe model.hbm");
 const bool configured=argc==3;
 if(configured)ainvr::BpuModel::ConfigureResidency({{ainvr::BpuModel::ResidencyKey(argv[1]),{"test:a","test:b"}}});
 auto before=Ion();auto a=ainvr::BpuModel::Acquire(argv[1]);auto single=Ion();auto b=ainvr::BpuModel::Acquire(argv[1]);auto shared=Ion();
 if(a!=b)throw std::runtime_error("duplicate model instance");
 auto description=a->Describe();std::vector<std::vector<unsigned char>> x,y;
 for(const auto& t:description["inputs"]){const auto bytes=t.at("aligned_bytes").get<size_t>();x.emplace_back(bytes,0);y.emplace_back(bytes,1);}
 const auto expected_x=a->Run(x),expected_y=b->Run(y);
 auto first=std::async(std::launch::async,[&]{for(int i=0;i<3;++i)if(a->Run(x)!=expected_x)throw std::runtime_error("first client output mismatch");});
 auto second=std::async(std::launch::async,[&]{for(int i=0;i<3;++i)if(b->Run(y)!=expected_y)throw std::runtime_error("second client output mismatch");});
 first.get();second.get();auto status=ainvr::BpuModel::SharedStatus();a.reset();if(b->Run(y)!=expected_y)throw std::runtime_error("remaining client broken");b.reset();
 if(configured){if(ainvr::BpuModel::SharedStatus()["instances"]!=1)throw std::runtime_error("configured weights were unloaded");ainvr::BpuModel::ConfigureResidency({});}
 if(ainvr::BpuModel::SharedStatus()["instances"]!=0)throw std::runtime_error("last lease not released");
 std::cout<<nlohmann::json({{"configured_lifecycle_verified",configured},{"same_instance",true},{"ion_before",before},{"ion_one_client",single},{"ion_two_clients",shared},{"second_client_ion_delta",int64_t(shared)-int64_t(single)},{"ion_after_release",Ion()},{"runtime",status},{"independent_outputs_verified",true}}).dump()<<'\n';
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

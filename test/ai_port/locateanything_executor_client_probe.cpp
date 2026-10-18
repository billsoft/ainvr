// Copyright AINVR. Explicit control-only IPC probe;no BPU/model success claim.
#include <iostream>
#include "platform/locateanything_executor_client.hpp"
int main(int argc,char**argv){
  if(argc!=2)return 2;
  auto require=[](bool value){if(!value)throw std::runtime_error("IPC assertion failed");};
  ainvr::LocateAnythingExecutorClient client(argv[1],std::string(64,'1'),2);
  require(client.Health().at("control_only")==true);
  require(client.Validate("a person wearing a helmet",128).at("valid")==true);
  std::vector<float> pixels(3*224*448);
  for(size_t i=0;i<pixels.size();++i)pixels[i]=(float(i%255)-127.0f)/127.5f;
  require(client.Generate(pixels,"person",128).at("control_only")==true);
  size_t failures=0;
  auto reject=[&](const auto& operation){bool failed=false;try{operation();}catch(const std::exception&){failed=true;}require(failed);++failures;};
  reject([&]{ainvr::LocateAnythingExecutorClient wrong(argv[1],std::string(64,'2'),2);wrong.Health();});
  reject([&]{client.Generate({},"person",128);});
  reject([&]{client.Validate(std::string(4097,'x'),128);});
  reject([&]{client.Generate(pixels,"person",128,[]{return true;});});
  reject([&]{ainvr::LocateAnythingExecutorClient short_deadline(argv[1],std::string(64,'1'),.1);short_deadline.Generate(pixels,"slow-probe",128);});
  std::cout<<nlohmann::json({{"status","completed"},{"control_only",true},{"neural_calls",0},{"positive_cases",3},
     {"negative_cases",failures},{"scope","Real C++/Python local IPC including payload,contract mismatch,cancellation/deadline;not neural inference"}}).dump()<<"\n";
}

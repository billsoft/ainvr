// AINVR. Explicit bounded hardware integration probe, never an automatic test.
#include "bpu_text_encoder.hpp"
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <unistd.h>
using namespace ainvr::search;
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
double Ms(Clock::duration elapsed){return std::chrono::duration<double,std::milli>(elapsed).count();}
double Cos(const std::vector<float>& a,const std::vector<float>& b){
  if(a.size()!=b.size()||a.size()!=768)throw std::runtime_error("probe_dimension_mismatch");
  double dot=0,aa=0,bb=0;for(size_t i=0;i<a.size();++i){
    if(!std::isfinite(a[i])||!std::isfinite(b[i]))throw std::runtime_error("probe_nonfinite_output");
    dot+=double(a[i])*b[i];aa+=double(a[i])*a[i];bb+=double(b[i])*b[i];}
  if(aa<=0||bb<=0)throw std::runtime_error("probe_zero_output");
  return dot/std::sqrt(aa*bb);
}
int main(int argc,char** argv){
 try{
  if(argc!=4)throw std::runtime_error("usage: probe input.json iterations output.json");
  const auto iterations=std::stoul(argv[2]);if(iterations<1||iterations>2048)throw std::runtime_error("probe_iteration_bound");
  std::ifstream input(argv[1]);Json source;input>>source;
  if(source.at("model")!="siglip2-base-full-int8"||(!source.at("inputs").is_array()||source.at("inputs").empty()||source.at("inputs").size()>128))throw std::runtime_error("probe_reference_invalid");
  Json report={{"schema",1},{"model","siglip2-base-full-int8"},{"pid",getpid()},{"iterations",iterations},{"source_sha256",source.at("source_sha256")}};
  report["ion_before_load"]=ainvr::IonBytesOfPid(getpid());
  const auto start=Clock::now();auto package=VerifyPackage("siglip2-base-full-int8");
  report["verify_ms"]=Ms(Clock::now()-start);report["model_version"]=package.model_version;
  std::cout<<"package_verified; beginning guarded text load\n"<<std::flush;
  const auto loading=Clock::now();auto encoder=BpuTextEncoder::Load(std::move(package));
  report["load_ms"]=Ms(Clock::now()-loading);report["ion_loaded"]=ainvr::IonBytesOfPid(getpid());
  report["queries"]=Json::array();
  for(const auto& row:source.at("inputs")){
    const auto before=Clock::now();const auto actual=encoder->Encode(row.at("text"));
    const auto cosine=Cos(actual,row.at("reference").get<std::vector<float>>());
    const auto prior=Cos(actual,row.at("previous_hbm").get<std::vector<float>>());
    report["queries"].push_back({{"id",row.at("id")},{"text",row.at("text")},{"cos_float",cosine},{"cos_previous_hbm",prior},{"ms",Ms(Clock::now()-before)}});
    if(cosine<0.99||prior<0.999)throw std::runtime_error("probe_output_mismatch");
  }
  const std::string text=source.at("inputs").at(0).at("text");
  for(int i=0;i<16;++i)(void)encoder->Encode(text);
  const auto ion_warm=ainvr::IonBytesOfPid(getpid());report["ion_after_warmup"]=ion_warm;
  const auto loop=Clock::now();for(size_t i=0;i<iterations;++i)(void)encoder->Encode(text);
  report["repeat_mean_ms"]=Ms(Clock::now()-loop)/iterations;
  const auto ion_after=ainvr::IonBytesOfPid(getpid());report["ion_after_repeat"]=ion_after;
  const bool stable=ion_after<=ion_warm+4ULL*1024*1024;
  encoder.reset();report["ion_after_unload"]=ainvr::IonBytesOfPid(getpid());report["passed"]=stable;
  std::ofstream output(argv[3]);output<<report.dump(2)<<'\n';if(!output)throw std::runtime_error("probe_report_write_failed");
  std::cout<<report.dump(2)<<'\n';return stable?0:1;
 }catch(const std::exception& error){std::cerr<<"text_probe_failed: "<<error.what()<<'\n';return 1;}
}

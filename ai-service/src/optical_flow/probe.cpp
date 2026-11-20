// Copyright AINVR. Explicit bounded hardware probe, never registered with CTest.
#include "runtime.hpp"
#include "filters.hpp"
#include <fstream>
#include <iostream>
#include <cmath>
#include <openssl/evp.h>
using namespace ainvr::flow;
namespace {
std::vector<uint8_t> Read(const char* path){
  std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error("JPEG fixture missing");
  std::vector<uint8_t> v((std::istreambuf_iterator<char>(f)),{});
  if(v.size()>kMaxJpeg)throw std::runtime_error("JPEG fixture too large");return v;
}
void FiltersTest(){
  Filters f;std::vector<float> input(3*kPixels);
  for(size_t c=0;c<3;++c)for(size_t i=0;i<kPixels;++i)input[c*kPixels+i]=float(c*40+17);
  input[100*512+100]=255;auto median=f.Median(input);
  if(median[100*512+100]!=17||median[kPixels+100*512+100]!=57)throw std::runtime_error("median channel/impulse failure");
  for(size_t i=0;i<input.size();++i)input[i]=float((i*97+i/512*13)%256);
  median=f.Median(input);
  for(int c=0;c<3;++c)for(int y=0;y<kHeight;++y)for(int x=0;x<kWidth;++x){
    float sample[9];int n=0;
    for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)
      sample[n++]=input[c*kPixels+std::clamp(y+dy,0,kHeight-1)*kWidth+std::clamp(x+dx,0,kWidth-1)];
    std::sort(sample,sample+9);
    if(median[c*kPixels+y*kWidth+x]!=sample[4])throw std::runtime_error("median test oracle mismatch");
  }
  // Signed independent planes and exact impulse response, plus CPU TEST ORACLE.
  std::vector<float> flow(2*kPixels);
  for(size_t i=0;i<kPixels;++i){flow[i]=-10+float(i%31)/4;flow[kPixels+i]=3-float(i%17)/3;}
  auto actual=f.Gaussian(flow);double max_error=0;
  for(int c=0;c<2;++c)for(int y=0;y<kHeight;++y)for(int x=0;x<kWidth;++x){
    double expected=0;
    for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx)
      expected+=flow[c*kPixels+std::clamp(y+dy,0,kHeight-1)*kWidth+std::clamp(x+dx,0,kWidth-1)]*(dx==0?2:1)*(dy==0?2:1)/16.0;
    max_error=std::max(max_error,std::abs(actual[c*kPixels+y*kWidth+x]-expected));
  }
  if(max_error>0.00001)throw std::runtime_error("signed Gaussian oracle mismatch");
  std::cout<<Json{{"filter_test","passed"},{"gaussianMaxError",max_error},{"signedDx",actual[0]}}.dump()<<'\n';
}
}
int main(int argc,char** argv){try{
  if(argc==2&&std::string(argv[1])=="--filters"){FiltersTest();return 0;}
  if(argc!=4)throw std::runtime_error("usage: optical_flow_probe MODEL_ROOT FRAME0.jpg FRAME1.jpg | --filters");
  auto a=Read(argv[2]),b=Read(argv[3]);
  auto encode=[](const std::vector<uint8_t>& v){std::string s(4*((v.size()+2)/3)+1,'\0');
    int n=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(s.data()),v.data(),v.size());s.resize(n);return s;};
  auto pair=Json{{"frame0",encode(a)},{"frame1",encode(b)}}.dump();
  auto identical=Json{{"frame0",encode(a)},{"frame1",encode(a)}}.dump();
  std::string token(32,'p');Peer peer{"127.0.0.1",token};double load_ms=0;
  auto factory=NativeFactory(argv[1]);
  Runtime runtime([&]{return token;},[]{return true;},[&]{auto t=std::chrono::steady_clock::now();
    auto backend=factory();load_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count();return backend;});
  auto start=std::chrono::steady_clock::now();
  auto cold=runtime.Call(pair,peer);
  cold["loadMs"]=load_ms;
  cold["coldTotalMs"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  std::cout<<Json{{"cold",cold}}.dump()<<'\n';
  std::cout<<Json{{"warm",runtime.Call(pair,peer)}}.dump()<<'\n';
  auto same=runtime.Call(identical,peer);
  if(std::hypot(same["dx"].get<double>(),same["dy"].get<double>())>1.0)throw std::runtime_error("identical pair exceeds 1px mean motion");
  std::cout<<Json{{"identical",same}}.dump()<<'\n';return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

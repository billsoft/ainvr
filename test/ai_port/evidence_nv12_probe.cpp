// Hardware-only A/B probe on identical decoded frames. JPEG decoding/PSNR is an external test oracle.
#include "output/snapshot_jpeg.hpp"
#include "platform/gles_preprocess.hpp"
#include "stream/media_source.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
using Clock=std::chrono::steady_clock;
int main(int argc,char** argv){try{
 if(argc!=3)throw std::invalid_argument("source and new output directory required");
 std::filesystem::path out=argv[2];if(std::filesystem::exists(out))throw std::runtime_error("output exists");std::filesystem::create_directories(out);
 ainvr::MediaSource source(argv[1],5000);const auto info=source.Info();ainvr::VpuDecoder decoder(info.codec,info.width,info.height);ainvr::GlesPreprocessor gpu;
 auto rows=nlohmann::json::array();uint64_t submitted=0;bool started=false;const auto deadline=Clock::now()+std::chrono::seconds(60);
 auto receive=[&](int timeout){auto frame=decoder.Receive(timeout);if(!frame||rows.size()>=4)return;
  const int n=int(rows.size());const bool bt709=n&1?!info.bt709:info.bt709;const bool full=n&2?!info.full_range:info.full_range;
  const double scale=std::min(1.0,1280.0/std::max(frame->width,frame->height));int w=std::max(32,int(frame->width*scale)/2*2),h=std::max(32,int(frame->height*scale)/2*2);
  std::vector<double> old_ms,new_ms;
  for(int repeat=0;repeat<3;++repeat){
   auto at=Clock::now();ainvr::ImageTransform t;t.width=w;t.height=h;t.letterbox=false;t.yuv_bt709=bt709;t.yuv_full_range=full;
   auto rgba=gpu.RunNv12Rgba(frame->pixels,frame->width,frame->height,t);cv::Mat mat(h,w,CV_8UC4);std::memcpy(mat.data,rgba.data(),rgba.size());std::vector<uint8_t> reference,direct;
   ai_service::output::EncodeSnapshotRgbaJpeg(mat,reference,85);old_ms.push_back(std::chrono::duration<double,std::milli>(Clock::now()-at).count());
   at=Clock::now();ai_service::output::EncodeSnapshotNv12Jpeg(frame->pixels,frame->width,frame->height,w,h,bt709,full,direct,85);new_ms.push_back(std::chrono::duration<double,std::milli>(Clock::now()-at).count());
   if(repeat==2){for(const auto& item:std::vector<std::pair<std::string,const std::vector<uint8_t>*>>{{"reference",&reference},{"direct",&direct}}){std::ofstream f(out/(std::to_string(n)+"-"+item.first+".jpg"),std::ios::binary);f.write(reinterpret_cast<const char*>(item.second->data()),item.second->size());if(!f)throw std::runtime_error("JPEG output failure");}}
  }
  rows.push_back({{"frame",n},{"width",w},{"height",h},{"source_bt709",bt709},{"source_full_range",full},{"reference_ms",old_ms},{"direct_ms",new_ms}});
 };
 for(int read=0;rows.size()<4&&Clock::now()<deadline&&read<600;++read){auto packet=source.Read();if(!packet)break;if(!started){if(!packet->key_frame)continue;started=true;}const auto until=Clock::now()+std::chrono::seconds(5);while(!decoder.Submit(packet->bytes,submitted,50)){receive(50);if(Clock::now()>until)throw std::runtime_error("decoder stalled");}++submitted;receive(50);}
 if(rows.size()!=4)throw std::runtime_error("insufficient hardware frames");source.Cancel();std::ofstream f(out/"report.json");f<<nlohmann::json{{"scope","VPU/GLES/JPU; four identical-frame comparisons including explicit matrix/range variants; not model accuracy"},{"cpu_image_fallback",false},{"rows",rows}}.dump(2);std::cout<<"HARDWARE_PROBE_COMPLETE\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

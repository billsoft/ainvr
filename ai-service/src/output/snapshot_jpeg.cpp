// Copyright AINVR. Hardware adaptation only; original archive business is reused.
#include "snapshot_jpeg.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef AINVR_ARCHIVE_JPU
#include "../platform/jpeg_encoder.hpp"
#include "../platform/gles_preprocess.hpp"
#include "../platform/gles_crop.hpp"
#endif
namespace ai_service::output {
namespace {
std::atomic<uint64_t> hardware_count{0}, failure_count{0}, gpu_count{0};
std::atomic<uint64_t> encoder_creates{0}, encoder_reuses{0};
#ifdef AINVR_ARCHIVE_JPU
struct Job {
 std::vector<uint8_t> pixels;
 int width,height,quality;
 bool rgba;
 std::promise<std::vector<uint8_t>> result;
};
class HardwareJpeg {
 public:
 HardwareJpeg():worker_([this]{Loop();}){}
 ~HardwareJpeg(){
  {std::lock_guard<std::mutex> lock(mutex_);stopping_=true;}
  available_.notify_all();worker_.join();
 }
 std::vector<uint8_t> Run(const cv::Mat& input,int quality,bool rgba){
  auto job=std::make_unique<Job>();job->width=input.cols;job->height=input.rows;job->quality=quality;
  job->rgba=rgba;
  const size_t row=size_t(input.cols)*(rgba?4:3);job->pixels.resize(row*input.rows);
  // Memory transfer only; GPU handles channel order, colors, chroma and padding.
  for(int y=0;y<input.rows;++y)std::memcpy(job->pixels.data()+size_t(y)*row,input.ptr(y),row);
  auto result=job->result.get_future();
  {std::unique_lock<std::mutex> lock(mutex_);
   available_.wait(lock,[&]{return stopping_||(jobs_.size()<4&&queued_bytes_+job->pixels.size()<=size_t(256)*1024*1024);});
   if(stopping_)throw std::runtime_error("Snapshot JPEG worker is stopping");
   queued_bytes_+=job->pixels.size();jobs_.push_back(std::move(job));}
  available_.notify_all();return result.get();
 }
 private:
 void Loop(){
  // Construct, use and destroy the GLES context on this one worker thread.
  std::unique_ptr<ainvr::GlesPreprocessor> colors;
  struct Slot { std::array<int,5> key;std::unique_ptr<ainvr::JpegEncoder> encoder; };
  std::deque<Slot> encoders;
  while(true){
   std::unique_ptr<Job> job;
   {std::unique_lock<std::mutex> lock(mutex_);
    available_.wait(lock,[&]{return stopping_||!jobs_.empty();});
    if(jobs_.empty()&&stopping_)break;
    job=std::move(jobs_.front());jobs_.pop_front();queued_bytes_-=job->pixels.size();}
   available_.notify_all();
   try {
    // Generate the entire SDK-aligned plane on GPU so the encoder only copies
    // bytes; no CPU pixel padding is needed for archive snapshots.
    const int w=std::max(32,(job->width+15)&~15),h=std::max(32,(job->height+7)&~7);
    ainvr::ImageTransform transform;transform.width=w;transform.height=h;
    transform.nearest=true;transform.letterbox=false;
    transform.source_region=std::array<float,4>{0,0,float(w),float(h)};
    if(!colors)colors=std::make_unique<ainvr::GlesPreprocessor>();
    auto nv12=job->rgba
      ? colors->RunRgbaJpegNv12(job->pixels,job->width,job->height,transform)
      : colors->RunBgrJpegNv12(job->pixels,job->width,job->height,transform);++gpu_count;
    const std::array<int,5> next{w,h,job->quality,job->width,job->height};
    // Keep the validated single-context behavior for SDK-padded visible sizes.
    // Concurrent cached JPU contexts can change odd-crop bitstreams on this SDK.
    const bool cacheable=job->width%16==0&&job->height%16==0;
    if(cacheable&&std::any_of(encoders.begin(),encoders.end(),[](const Slot& slot){return slot.key[3]%16||slot.key[4]%16;}))encoders.clear();
    if(!cacheable)while(encoders.size()>1)encoders.pop_front();
    auto cached=std::find_if(encoders.begin(),encoders.end(),[&](const Slot& slot){return slot.key==next;});
    if(cached!=encoders.end()){
      auto slot=std::move(*cached);encoders.erase(cached);encoders.push_back(std::move(slot));++encoder_reuses;
    }else{
      // Two small contexts cover original/enhanced image pairs. Large captures
      // retain only one context; changing sizes cannot grow the pool unbounded.
      auto area=[&]{size_t sum=0;for(const auto& slot:encoders)sum+=size_t(slot.key[0])*slot.key[1];return sum;};
      while(!encoders.empty()&&(encoders.size()>=(cacheable?2u:1u)||area()+size_t(w)*h>size_t(2)*1024*1024))encoders.pop_front();
      encoders.push_back({next,std::make_unique<ainvr::JpegEncoder>(w,h,job->quality,job->width,job->height)});++encoder_creates;
    }
    auto bytes=encoders.back().encoder->EncodeFullRangeNv12(nv12);
    if(bytes.empty())throw std::runtime_error("JPU returned empty JPEG");
    ++hardware_count;job->result.set_value(std::move(bytes));
   }catch(...){encoders.clear();colors.reset();++failure_count;job->result.set_exception(std::current_exception());}
  }
 }
 std::mutex mutex_;
 std::condition_variable available_;
 std::deque<std::unique_ptr<Job>> jobs_;
 size_t queued_bytes_=0;
 bool stopping_=false;
 std::thread worker_;
};
#endif
}
SnapshotJpegStats GetSnapshotJpegStats(){return {hardware_count.load(),0,failure_count.load(),gpu_count.load(),encoder_creates.load(),encoder_reuses.load()};}
cv::Mat EnsureSnapshotJpuCanvas(const cv::Mat& rgba){
 if(rgba.empty()||rgba.type()!=CV_8UC4||rgba.cols>8192||rgba.rows>8192)
  throw std::invalid_argument("Invalid snapshot RGBA canvas");
 if(rgba.cols>=17&&rgba.rows>=17)return rgba;
#ifdef AINVR_ARCHIVE_JPU
 static thread_local std::unique_ptr<ainvr::GlesCropBackend> gpu;
 const cv::Size size(std::max(17,rgba.cols),std::max(17,rgba.rows));
 try{
  if(!gpu)gpu=std::make_unique<ainvr::GlesCropBackend>();
  gpu->Upload(rgba);
  return gpu->Area(cv::Rect({},size),size);
 }catch(...){gpu.reset();throw;}
#else
 throw std::runtime_error("Snapshot canvas hardware is unavailable");
#endif
}
namespace {
bool Encode(const cv::Mat& input,std::vector<uint8_t>& out,int quality,bool rgba){
 out.clear();
 if(input.empty()||input.type()!=(rgba?CV_8UC4:CV_8UC3)||quality<1||quality>100)
  throw std::invalid_argument("Invalid snapshot JPEG input or quality");
 if(input.cols<17||input.rows<17||input.cols>8192||input.rows>8192)
  throw std::invalid_argument("Snapshot hardware JPEG requires visible dimensions 17..8192; CPU image fallback is disabled");
#ifdef AINVR_ARCHIVE_JPU
 // Both APIs share one hardware queue and one owning GLES thread.
 static HardwareJpeg worker;out=worker.Run(input,quality,rgba);return true;
#else
 throw std::runtime_error("Snapshot hardware JPEG backend is unavailable; CPU image fallback is disabled");
#endif
}
}
bool EncodeSnapshotJpeg(const cv::Mat& input,std::vector<uint8_t>& out,int quality){
 return Encode(input,out,quality,false);
}
bool EncodeSnapshotRgbaJpeg(const cv::Mat& input,std::vector<uint8_t>& out,int quality){
 return Encode(input,out,quality,true);
}
}

#pragma once
// Generic bounded full-frame evidence cache. No alarm geometry/model decisions.
#include "snapshot_jpeg.hpp"
#include "result.hpp"
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <algorithm>
#include <chrono>
#include <array>
#include <atomic>
#include <sys/vfs.h>
#include <cstdlib>
#include <ctime>
#include <stdexcept>
#include <vector>
#include <set>
#include <filesystem>
#include <fstream>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <deque>
#include <functional>
#include <future>
#include <fcntl.h>
#include <cerrno>
#include <sys/stat.h>
#include <unistd.h>
namespace ai_service::output {
// A non-tracking channel still exports real detections. Predicted-only tracks
// do not create a useful review image and must not consume scarce cache slots.
inline bool HasReviewVisualTarget(const FrameResult& result) {
 if(!result.detections.empty())return true;
 const auto a=result.model_extra.find("analytics");
 if(a==result.model_extra.end()||!a->is_object())return false;
 const auto tracks=a->find("tracks");if(tracks==a->end()||!tracks->is_array())return false;
 for(const auto& t:*tracks)if(t.value("observation",std::string())=="detected"&&t.value("event_eligible",false))return true;
 return false;
}
struct ReviewEncodedFrame {std::vector<uint8_t> jpeg;int width=0,height=0;};
class ReviewFrameCache {
 using Json=nlohmann::json;
 static constexpr size_t queue_capacity_=8;
 static constexpr uintmax_t pixel_capacity_=256ULL*1024*1024,jpeg_capacity_=2ULL*1024*1024*1024;
 static constexpr int ttl_seconds_=30,requested_ttl_seconds_=60;
 struct Job {std::string key;Json metadata;std::function<ReviewEncodedFrame()> render;uintmax_t retained_bytes=0;std::shared_ptr<std::promise<bool>> completion;std::chrono::steady_clock::time_point admitted;};
 std::filesystem::path root_,raw_;std::atomic<uint64_t> dropped_{0},failed_{0},written_{0},evicted_{0};std::mutex mutex_;std::condition_variable ready_,space_;
 std::deque<Job> jobs_;bool stop_=false;std::thread worker_;
 uintmax_t retained_pixel_bytes_=0;
 std::atomic<uint64_t> queue_dropped_{0},pixel_dropped_{0},invalid_dropped_{0},protected_evicted_{0};
 std::string last_report_;uintmax_t cached_bytes_=0;
 std::chrono::steady_clock::time_point maintained_{};
 uint64_t maintenance_scans_=0;
 std::atomic<uint64_t> backpressure_waits_{0},canceled_admissions_{0};
 std::atomic<uint64_t> completed_{0},completion_total_us_{0},completion_max_us_{0};
 Json policy_;std::chrono::steady_clock::time_point checked_{}, reported_{};
 static std::string Hash(const std::string& s){unsigned char bytes[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(s.data()),s.size(),bytes);std::string out;for(auto b:bytes){out+="0123456789abcdef"[b>>4];out+="0123456789abcdef"[b&15];}return out;}
 void Write(const std::filesystem::path& p,const char* data,size_t n){
  auto tmp=p;tmp+=".tmp";int fd=open(tmp.c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC,0600);
  if(fd<0)throw std::runtime_error("evidence write open");
  try{size_t at=0;while(at<n){auto count=write(fd,data+at,n-at);if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("evidence write");at+=size_t(count);}
   if(fsync(fd))throw std::runtime_error("evidence fsync");close(fd);fd=-1;std::filesystem::rename(tmp,p);
   const int dir=open(p.parent_path().c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(dir<0)throw std::runtime_error("evidence directory");const int rc=fsync(dir);close(dir);if(rc)throw std::runtime_error("evidence directory fsync");
  }catch(...){if(fd>=0)close(fd);std::error_code ec;std::filesystem::remove(tmp,ec);throw;}
 }
 // Stage both immutable payloads before the first sync. A single directory
 // sync commits both names; the receipt still requires TWO file syncs plus the
 // directory sync. Consumers see this frame only after its durable receipt.
 void WriteFrame(const std::string& key,const std::vector<uint8_t>& jpeg,const std::string& metadata){
  std::array<std::filesystem::path,2> names{raw_/(key+".jpg"),raw_/(key+".json")},temp=names;
  for(auto& path:temp)path+=".tmp";
  std::array<int,2> descriptors{-1,-1};std::array<bool,2> opened{false,false};
  const std::array<const char*,2> data{reinterpret_cast<const char*>(jpeg.data()),metadata.data()};
  const std::array<size_t,2> sizes{jpeg.size(),metadata.size()};
  try{
   for(size_t i=0;i<2;++i){
    descriptors[i]=open(temp[i].c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NOFOLLOW,0600);
    if(descriptors[i]<0)throw std::runtime_error("evidence pair open");opened[i]=true;
    size_t at=0;while(at<sizes[i]){const auto n=write(descriptors[i],data[i]+at,sizes[i]-at);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("evidence pair write");at+=size_t(n);}
   }
   for(auto fd:descriptors)if(fsync(fd))throw std::runtime_error("evidence pair fsync");
   for(auto& fd:descriptors){const auto closing=fd;fd=-1;if(close(closing))throw std::runtime_error("evidence pair close");}
   for(size_t i=0;i<2;++i)std::filesystem::rename(temp[i],names[i]);
   const int dir=open(raw_.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(dir<0)throw std::runtime_error("evidence pair directory");const int rc=fsync(dir);close(dir);if(rc)throw std::runtime_error("evidence pair directory fsync");
  }catch(...){for(size_t i=0;i<2;++i){if(descriptors[i]>=0)close(descriptors[i]);if(opened[i]){std::error_code ec;std::filesystem::remove(temp[i],ec);}}throw;}
 }
 void RefreshPolicy(){
  const auto now=std::chrono::steady_clock::now();if(now-checked_<std::chrono::seconds(1))return;checked_=now;
  Json next;try{std::ifstream f(root_/"enabled.json");f>>next;}catch(...){return;}
  std::lock_guard<std::mutex> lock(mutex_);policy_=std::move(next);
 }
 void Maintain(uintmax_t incoming){
  if(incoming>jpeg_capacity_)throw std::runtime_error("Evidence frame exceeds cache budget");
  const auto tick=std::chrono::steady_clock::now();
  // Only this worker creates evidence. Keep a conservative byte total between
  // scans; ACKs/pins are consulted afresh during each cleanup. Never evict an
  // unacknowledged or pinned frame to make room for a new one.
  if(maintained_.time_since_epoch().count()!=0 && tick-maintained_<std::chrono::seconds(1)){
   if(incoming>jpeg_capacity_-std::min(jpeg_capacity_,cached_bytes_))throw std::runtime_error("Evidence spool capacity exhausted");
   return;
  }
  ++maintenance_scans_;
  const auto now=std::filesystem::file_time_type::clock::now();
  std::vector<std::pair<std::filesystem::file_time_type,std::filesystem::path>> files;uintmax_t size=0;
  for(auto& e:std::filesystem::directory_iterator(raw_)){if(!e.is_regular_file()||e.path().extension()!=".jpg")continue;files.push_back({e.last_write_time(),e.path()});size+=e.file_size();auto meta=e.path();meta.replace_extension(".json");std::error_code ec;if(std::filesystem::exists(meta,ec))size+=std::filesystem::file_size(meta,ec);}
  // Unacknowledged frames and checkpoint-owned frames never expire. A bounded
  // full spool reports admission failure instead of deleting pending evidence.
  std::set<std::string> retained;
  for(const auto& e:std::filesystem::directory_iterator(raw_))if(e.path().extension()==".pin")retained.insert(e.path().filename().string().substr(0,64));
  for(auto& item:files){
   const auto key=item.second.stem().string();auto ack=raw_/(key+".ack");std::error_code ec;
   if(retained.count(key)||!std::filesystem::exists(ack,ec)||now-std::filesystem::last_write_time(ack,ec)<std::chrono::seconds(ttl_seconds_))continue;
   auto meta=raw_/(key+".json");auto n=std::filesystem::file_size(item.second,ec);if(std::filesystem::exists(meta,ec))n+=std::filesystem::file_size(meta,ec);
   std::filesystem::remove(item.second);std::filesystem::remove(meta);std::filesystem::remove(ack);size=size>n?size-n:0;++evicted_;
  }
  cached_bytes_=size;maintained_=tick;
  if(size+incoming>jpeg_capacity_)throw std::runtime_error("Evidence spool capacity exhausted");
 }
 void Report(){const auto tick=std::chrono::steady_clock::now();if(tick-reported_<std::chrono::seconds(1))return;reported_=tick;size_t queued;uintmax_t pixels;{std::lock_guard<std::mutex> lock(mutex_);queued=jobs_.size();pixels=retained_pixel_bytes_;}const auto stats=Json{{"backpressure_waits",backpressure_waits_.load()},{"canceled_admissions",canceled_admissions_.load()},{"completion_count",completed_.load()},{"completion_mean_ms",completed_.load()?double(completion_total_us_.load())/completed_.load()/1000:0},{"completion_max_ms",double(completion_max_us_.load())/1000},{"maintenance_scans",maintenance_scans_},{"written",written_.load()},{"dropped",dropped_.load()},{"queue_full_dropped",queue_dropped_.load()},{"pixel_budget_dropped",pixel_dropped_.load()},{"invalid_dropped",invalid_dropped_.load()},{"failed",failed_.load()},{"render_encode_or_cache_failed",failed_.load()},{"evicted",evicted_.load()},{"protected_evicted",protected_evicted_.load()},{"cached_bytes",cached_bytes_},{"max_bytes",jpeg_capacity_},{"queued",queued},{"queue_capacity",queue_capacity_},{"retained_pixel_bytes",pixels},{"max_retained_pixel_bytes",pixel_capacity_},{"ttl_seconds",ttl_seconds_},{"requested_ttl_seconds",requested_ttl_seconds_}}.dump();if(stats==last_report_)return;Write(root_/"cache-status.json",stats.data(),stats.size());last_report_=stats;}
 void Run(){
  for(;;){Job j;{std::unique_lock<std::mutex> l(mutex_);if(!ready_.wait_for(l,std::chrono::seconds(1),[&]{return stop_||!jobs_.empty();})){l.unlock();try{RefreshPolicy();Maintain(0);Report();}catch(...){++failed_;}continue;}if(stop_&&jobs_.empty())return;j=std::move(jobs_.front());jobs_.pop_front();}
   bool saved=false;
   try{auto image=j.render();const auto& jpeg=image.jpeg;
    if(image.width<=0||image.height<=0||jpeg.size()<4||jpeg.size()>8ULL*1024*1024||jpeg[0]!=255||jpeg[1]!=216||jpeg[jpeg.size()-2]!=255||jpeg.back()!=217)throw std::runtime_error("evidence encode");
    j.metadata["image_width"]=image.width;j.metadata["image_height"]=image.height;
    j.metadata["schema_version"]=2;j.metadata["bytes"]=jpeg.size();j.metadata["sha256"]=Hash(std::string(reinterpret_cast<const char*>(jpeg.data()),jpeg.size()));
    const auto m=j.metadata.dump();Maintain(jpeg.size()+m.size());cached_bytes_+=jpeg.size()+m.size();WriteFrame(j.key,jpeg,m);++written_;saved=true;
   }catch(...){++failed_;maintained_={};/* A missing exact frame is an explicit review evidence failure, never a nearest-time substitution. */}
   // Drop the raw FrameRef before returning its pixel reservation. Count the
   // active renderer as well as queued frames, including after a render failure.
   j.render={};{std::lock_guard<std::mutex> lock(mutex_);retained_pixel_bytes_-=j.retained_bytes;}space_.notify_all();
   const auto us=uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-j.admitted).count());
   ++completed_;completion_total_us_+=us;completion_max_us_=std::max(completion_max_us_.load(),us);
   j.completion->set_value(saved);
   try{RefreshPolicy();Report();}catch(...){++failed_;}
  }
 }
 public:
 ReviewFrameCache(){const char* p=std::getenv("AINVR_REVIEW_FRAME_ROOT");if(!p)return;root_=p;
  if(root_.string().rfind("/mnt/ainvr-ssd/",0)!=0||root_.lexically_normal()!=root_)throw std::runtime_error("SSD evidence root required");
  // Evidence history belongs on the removable SSD. Its absence must neither
  // block live inference nor create an unbounded history on the system disk.
  struct stat disk{},parent{};
  if(stat("/mnt/ainvr-ssd",&disk)||stat("/mnt",&parent)||disk.st_dev==parent.st_dev||access("/mnt/ainvr-ssd",R_OK|X_OK)!=0){root_.clear();return;}
  std::filesystem::create_directories(root_);if(std::filesystem::canonical(root_)!=root_)throw std::runtime_error("Evidence root must not be a symlink");chmod(root_.c_str(),0700);
  raw_=root_/"raw";std::filesystem::create_directories(raw_);
  if(std::filesystem::canonical(raw_)!=raw_)throw std::runtime_error("Evidence spool symlink");
  chmod(raw_.c_str(),0700);RefreshPolicy();worker_=std::thread([this]{Run();});}
 ~ReviewFrameCache(){{std::lock_guard<std::mutex> l(mutex_);stop_=true;}ready_.notify_all();space_.notify_all();if(worker_.joinable())worker_.join();}
 bool Enabled(const std::string& channel){if(root_.empty())return false;std::lock_guard<std::mutex> l(mutex_);
  if(!policy_.is_object()||!policy_.contains("expires_at")||!policy_["expires_at"].is_number_integer()||!policy_.contains("channels")||!policy_["channels"].is_array())return false;
  // Last committed desired configuration survives a database outage.
  // Explicit removal from channels disables capture; a lease timeout cannot.
  for(auto& c:policy_.value("channels",Json::array()))if(c==channel)return true;return false;
 }
 // Receipt becomes true only after BOTH files and their directory are durable.
 // Unsaturated admission does not wait for rendering/storage; the observation
 // writer owns the wait. A full queue rejects explicitly, never overcommits RAM.
 std::shared_future<bool> OfferAsync(Json metadata,std::function<cv::Mat()> render,size_t retained_bytes=0,std::function<bool()> canceled={}){
  if(!render)return OfferPreparedAsync(std::move(metadata),{},retained_bytes,std::move(canceled));
  return OfferPreparedAsync(std::move(metadata),[render=std::move(render)]{
   auto rgba=render();ReviewEncodedFrame image;image.width=rgba.cols;image.height=rgba.rows;
   if(!EncodeSnapshotRgbaJpeg(rgba,image.jpeg,85))throw std::runtime_error("evidence encode");return image;
  },retained_bytes,std::move(canceled));
 }
 // Prepared JPEG bytes are still checked, hashed and durably written by this
 // same bounded cache. Preparation alone cannot produce a successful receipt.
 std::shared_future<bool> OfferPreparedAsync(Json metadata,std::function<ReviewEncodedFrame()> render,size_t retained_bytes=0,std::function<bool()> canceled={}){
  auto completion=std::make_shared<std::promise<bool>>();auto done=completion->get_future().share();
  const auto reject=[&]{completion->set_value(false);return done;};
  try{
   const auto w=metadata.at("frame_width").get<int64_t>(),h=metadata.at("frame_height").get<int64_t>();
   if(w<=0||h<=0||w>16384||h>16384||w%2||h%2||!render)throw std::invalid_argument("invalid evidence pixels");
   const auto minimum=uintmax_t(w)*uintmax_t(h)*3/2;
   if(!retained_bytes)retained_bytes=minimum;
   if(retained_bytes<minimum)throw std::invalid_argument("unaccounted evidence pixels");
   auto text=metadata.at("channel_id").get<std::string>()+"\n"+metadata.at("stream_session_id").get<std::string>()+"\n"+metadata.at("source_pts_ns").get<std::string>()+"\n"+metadata.at("source_frame_index").get<std::string>();
   const auto key=Hash(text);
   {std::unique_lock<std::mutex> l(mutex_);if(root_.empty()||stop_)return reject();
   if(retained_bytes>pixel_capacity_){++dropped_;++pixel_dropped_;return reject();}
   const auto full=[&]{return jobs_.size()>=queue_capacity_||retained_bytes>pixel_capacity_-std::min(pixel_capacity_,retained_pixel_bytes_);};
   // Required live evidence applies bounded backpressure only at saturation.
   // Never discard an already selected frame merely because storage is busy.
   // Optional/test callers can still request immediate, explicit rejection.
   if(canceled&&full()){
    ++backpressure_waits_;
    while(!stop_&&full()){
     if(canceled()){++canceled_admissions_;return reject();}
     space_.wait_for(l,std::chrono::milliseconds(20));
    }
   }
   if(stop_||(canceled&&canceled())){++canceled_admissions_;return reject();}
   if(jobs_.size()>=queue_capacity_){++dropped_;++queue_dropped_;return reject();}
   if(retained_bytes>pixel_capacity_-std::min(pixel_capacity_,retained_pixel_bytes_)){++dropped_;++pixel_dropped_;return reject();}
   jobs_.push_back({key,std::move(metadata),std::move(render),retained_bytes,completion,std::chrono::steady_clock::now()});retained_pixel_bytes_+=retained_bytes;ready_.notify_one();}
   return done;
  }catch(...){++dropped_;++invalid_dropped_;return reject();}
 }
 // Compatibility for synchronous callers/tests. The live channel uses OfferAsync.
 bool Offer(Json metadata,std::function<cv::Mat()> render,size_t retained_bytes=0){
  return OfferAsync(std::move(metadata),std::move(render),retained_bytes).get();
 }
};
inline ReviewFrameCache& SharedReviewFrameCache(){static ReviewFrameCache cache;return cache;}
}

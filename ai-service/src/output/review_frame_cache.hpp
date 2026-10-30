#pragma once
// Generic bounded full-frame evidence cache. No alarm geometry/model decisions.
#include "snapshot_jpeg.hpp"
#include "result.hpp"
#include <nlohmann/json.hpp>
#include <openssl/sha.h>
#include <algorithm>
#include <chrono>
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
class ReviewFrameCache {
 using Json=nlohmann::json;
 static constexpr size_t queue_capacity_=8;
 static constexpr uintmax_t pixel_capacity_=256ULL*1024*1024,jpeg_capacity_=128ULL*1024*1024;
 static constexpr int ttl_seconds_=30,requested_ttl_seconds_=60;
 struct Job {std::string key;Json metadata;std::function<cv::Mat()> render;uintmax_t retained_bytes=0;};
 std::filesystem::path root_,raw_;std::atomic<uint64_t> dropped_{0},failed_{0},written_{0},evicted_{0};std::mutex mutex_;std::condition_variable ready_;
 std::deque<Job> jobs_;bool stop_=false;std::thread worker_;
 uintmax_t retained_pixel_bytes_=0;
 std::atomic<uint64_t> queue_dropped_{0},pixel_dropped_{0},invalid_dropped_{0},protected_evicted_{0};
 std::string last_report_;uintmax_t cached_bytes_=0;
 Json policy_;std::chrono::steady_clock::time_point checked_{}, reported_{};
 static std::string Hash(const std::string& s){unsigned char bytes[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(s.data()),s.size(),bytes);std::string out;for(auto b:bytes){out+="0123456789abcdef"[b>>4];out+="0123456789abcdef"[b&15];}return out;}
 void Write(const std::filesystem::path& p,const char* data,size_t n){auto tmp=p;tmp+=".tmp";try{{std::ofstream f(tmp,std::ios::binary|std::ios::trunc);if(!f)throw std::runtime_error("evidence write");f.write(data,n);f.flush();if(!f)throw std::runtime_error("evidence write");}chmod(tmp.c_str(),0600);std::filesystem::rename(tmp,p);}catch(...){std::error_code ec;std::filesystem::remove(tmp,ec);throw;}}
 void RefreshPolicy(){
  const auto now=std::chrono::steady_clock::now();if(now-checked_<std::chrono::seconds(1))return;checked_=now;
  Json next;try{std::ifstream f(root_/"enabled.json");f>>next;}catch(...){next=Json();}
  std::lock_guard<std::mutex> lock(mutex_);policy_=std::move(next);
 }
 void Maintain(uintmax_t incoming){
  if(incoming>jpeg_capacity_)throw std::runtime_error("Evidence frame exceeds cache budget");
  const auto now=std::filesystem::file_time_type::clock::now();
  std::vector<std::pair<std::filesystem::file_time_type,std::filesystem::path>> files;uintmax_t size=0;
  for(auto& e:std::filesystem::directory_iterator(raw_)){if(!e.is_regular_file()||e.path().extension()!=".jpg")continue;files.push_back({e.last_write_time(),e.path()});size+=e.file_size();auto meta=e.path();meta.replace_extension(".json");std::error_code ec;if(std::filesystem::exists(meta,ec))size+=std::filesystem::file_size(meta,ec);}
  std::set<std::string> retained;
  {std::lock_guard<std::mutex> lock(mutex_);
   if(policy_.is_object()&&policy_.value("expires_at",0LL)>=static_cast<long long>(std::time(nullptr))&&policy_.contains("retained_keys")&&policy_["retained_keys"].is_array()&&policy_["retained_keys"].size()<=128)
    for(const auto& key:policy_["retained_keys"])if(key.is_string())retained.insert(key.get<std::string>());
  }
  auto protectedFrame=[&](const auto& item){return retained.count(item.second.stem().string())!=0;};
  std::sort(files.begin(),files.end(),[&](const auto& a,const auto& b){if(protectedFrame(a)!=protectedFrame(b))return !protectedFrame(a);return a.first<b.first;});
  for(auto& item:files)if(now-item.first>std::chrono::seconds(protectedFrame(item)?requested_ttl_seconds_:ttl_seconds_)||size+incoming>jpeg_capacity_){std::error_code ec;auto n=std::filesystem::file_size(item.second,ec);auto metadata=item.second;metadata.replace_extension(".json");if(std::filesystem::exists(metadata,ec))n+=std::filesystem::file_size(metadata,ec);std::filesystem::remove(item.second,ec);if(!ec){size=size>n?size-n:0;++evicted_;if(protectedFrame(item))++protected_evicted_;}auto meta=item.second;meta.replace_extension(".json");std::filesystem::remove(meta,ec);}
  cached_bytes_=size;
  if(size+incoming>jpeg_capacity_)throw std::runtime_error("Evidence cache eviction failed");
 }
 void Report(){const auto tick=std::chrono::steady_clock::now();if(tick-reported_<std::chrono::seconds(1))return;reported_=tick;size_t queued;uintmax_t pixels;{std::lock_guard<std::mutex> lock(mutex_);queued=jobs_.size();pixels=retained_pixel_bytes_;}const auto stats=Json{{"written",written_.load()},{"dropped",dropped_.load()},{"queue_full_dropped",queue_dropped_.load()},{"pixel_budget_dropped",pixel_dropped_.load()},{"invalid_dropped",invalid_dropped_.load()},{"failed",failed_.load()},{"render_encode_or_cache_failed",failed_.load()},{"evicted",evicted_.load()},{"protected_evicted",protected_evicted_.load()},{"cached_bytes",cached_bytes_},{"max_bytes",jpeg_capacity_},{"queued",queued},{"queue_capacity",queue_capacity_},{"retained_pixel_bytes",pixels},{"max_retained_pixel_bytes",pixel_capacity_},{"ttl_seconds",ttl_seconds_},{"requested_ttl_seconds",requested_ttl_seconds_}}.dump();if(stats==last_report_)return;Write(root_/"cache-status.json",stats.data(),stats.size());last_report_=stats;}
 void Run(){
  for(;;){Job j;{std::unique_lock<std::mutex> l(mutex_);if(!ready_.wait_for(l,std::chrono::seconds(1),[&]{return stop_||!jobs_.empty();})){l.unlock();try{RefreshPolicy();Maintain(0);Report();}catch(...){++failed_;}continue;}if(stop_)return;j=std::move(jobs_.front());jobs_.pop_front();}
   try{auto rgba=j.render();std::vector<uint8_t> jpeg;if(!EncodeSnapshotRgbaJpeg(rgba,jpeg,85))throw std::runtime_error("evidence encode");
    j.metadata["image_width"]=rgba.cols;j.metadata["image_height"]=rgba.rows;
    const auto m=j.metadata.dump();Maintain(jpeg.size()+m.size());Write(raw_/(j.key+".jpg"),reinterpret_cast<const char*>(jpeg.data()),jpeg.size());Write(raw_/(j.key+".json"),m.data(),m.size());++written_;cached_bytes_+=jpeg.size()+m.size();
   }catch(...){++failed_;/* A missing exact frame is an explicit review evidence failure, never a nearest-time substitution. */}
   // Drop the raw FrameRef before returning its pixel reservation. Count the
   // active renderer as well as queued frames, including after a render failure.
   j.render={};{std::lock_guard<std::mutex> lock(mutex_);retained_pixel_bytes_-=j.retained_bytes;}
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
  raw_="/dev/shm/ainvr-review-frames";std::filesystem::create_directories(raw_);
  struct statfs fs{};if(std::filesystem::canonical(raw_)!=raw_||statfs(raw_.c_str(),&fs)!=0||fs.f_type!=0x01021994)throw std::runtime_error("Evidence cache requires tmpfs");
  chmod(raw_.c_str(),0700);RefreshPolicy();worker_=std::thread([this]{Run();});}
 ~ReviewFrameCache(){{std::lock_guard<std::mutex> l(mutex_);stop_=true;for(const auto& job:jobs_)retained_pixel_bytes_-=job.retained_bytes;jobs_.clear();}ready_.notify_all();if(worker_.joinable())worker_.join();}
 bool Enabled(const std::string& channel){if(root_.empty())return false;std::lock_guard<std::mutex> l(mutex_);
  if(!policy_.is_object()||!policy_.contains("expires_at")||!policy_["expires_at"].is_number_integer()||!policy_.contains("channels")||!policy_["channels"].is_array())return false;
  if(policy_["expires_at"].get<long long>()<static_cast<long long>(std::time(nullptr)))return false;
  for(auto& c:policy_.value("channels",Json::array()))if(c==channel)return true;return false;
 }
 void Offer(Json metadata,std::function<cv::Mat()> render,size_t retained_bytes=0){
  try{
   const auto w=metadata.at("frame_width").get<int64_t>(),h=metadata.at("frame_height").get<int64_t>();
   if(w<=0||h<=0||w>16384||h>16384||w%2||h%2||!render)throw std::invalid_argument("invalid evidence pixels");
   const auto minimum=uintmax_t(w)*uintmax_t(h)*3/2;
   if(!retained_bytes)retained_bytes=minimum;
   if(retained_bytes<minimum)throw std::invalid_argument("unaccounted evidence pixels");
   auto text=metadata.at("channel_id").get<std::string>()+"\n"+metadata.at("stream_session_id").get<std::string>()+"\n"+metadata.at("source_pts_ns").get<std::string>()+"\n"+metadata.at("source_frame_index").get<std::string>();
   const auto key=Hash(text);std::lock_guard<std::mutex> l(mutex_);if(root_.empty()||stop_)return;
   if(jobs_.size()>=queue_capacity_){++dropped_;++queue_dropped_;return;}
   if(retained_bytes>pixel_capacity_-std::min(pixel_capacity_,retained_pixel_bytes_)){++dropped_;++pixel_dropped_;return;}
   jobs_.push_back({key,std::move(metadata),std::move(render),retained_bytes});retained_pixel_bytes_+=retained_bytes;ready_.notify_one();
  }catch(...){++dropped_;++invalid_dropped_;}
 }
};
inline ReviewFrameCache& SharedReviewFrameCache(){static ReviewFrameCache cache;return cache;}
}

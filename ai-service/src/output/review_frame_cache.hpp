#pragma once
// Generic bounded full-frame evidence cache. No alarm geometry/model decisions.
#include "snapshot_jpeg.hpp"
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
class ReviewFrameCache {
 using Json=nlohmann::json;
 struct Job {std::string key;Json metadata;std::function<cv::Mat()> render;};
 std::filesystem::path root_,raw_;std::atomic<uint64_t> dropped_{0},failed_{0},written_{0},evicted_{0};std::mutex mutex_;std::condition_variable ready_;
 std::deque<Job> jobs_;bool stop_=false;std::thread worker_;
 std::string last_report_;uintmax_t cached_bytes_=0;
 Json policy_;std::chrono::steady_clock::time_point checked_{}, reported_{};
 static std::string Hash(const std::string& s){unsigned char bytes[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(s.data()),s.size(),bytes);std::string out;for(auto b:bytes){out+="0123456789abcdef"[b>>4];out+="0123456789abcdef"[b&15];}return out;}
 void Write(const std::filesystem::path& p,const char* data,size_t n){auto tmp=p;tmp+=".tmp";{std::ofstream f(tmp,std::ios::binary|std::ios::trunc);if(!f)throw std::runtime_error("evidence write");f.write(data,n);f.flush();if(!f)throw std::runtime_error("evidence write");}chmod(tmp.c_str(),0600);std::filesystem::rename(tmp,p);}
 void Maintain(uintmax_t incoming){
  if(incoming>128ULL*1024*1024)throw std::runtime_error("Evidence frame exceeds cache budget");
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
  for(auto& item:files)if(now-item.first>std::chrono::seconds(protectedFrame(item)?60:10)||size+incoming>128ULL*1024*1024){std::error_code ec;auto n=std::filesystem::file_size(item.second,ec);auto metadata=item.second;metadata.replace_extension(".json");if(std::filesystem::exists(metadata,ec))n+=std::filesystem::file_size(metadata,ec);std::filesystem::remove(item.second,ec);if(!ec){size=size>n?size-n:0;++evicted_;}auto meta=item.second;meta.replace_extension(".json");std::filesystem::remove(meta,ec);}
  cached_bytes_=size;
  if(size+incoming>128ULL*1024*1024)throw std::runtime_error("Evidence cache eviction failed");
 }
 void Report(){const auto tick=std::chrono::steady_clock::now();if(tick-reported_<std::chrono::seconds(1))return;reported_=tick;const auto stats=Json{{"written",written_.load()},{"dropped",dropped_.load()},{"failed",failed_.load()},{"evicted",evicted_.load()},{"cached_bytes",cached_bytes_},{"max_bytes",128ULL*1024*1024},{"ttl_seconds",10},{"requested_ttl_seconds",60}}.dump();if(stats==last_report_)return;Write(root_/"cache-status.json",stats.data(),stats.size());last_report_=stats;}
 void Run(){
  for(;;){Job j;{std::unique_lock<std::mutex> l(mutex_);if(!ready_.wait_for(l,std::chrono::seconds(1),[&]{return stop_||!jobs_.empty();})){l.unlock();try{Maintain(0);Report();}catch(...){++failed_;}continue;}if(stop_)return;j=std::move(jobs_.front());jobs_.pop_front();}
   try{auto rgba=j.render();std::vector<uint8_t> jpeg;if(!EncodeSnapshotRgbaJpeg(rgba,jpeg,85))throw std::runtime_error("evidence encode");
    j.metadata["image_width"]=rgba.cols;j.metadata["image_height"]=rgba.rows;
    const auto m=j.metadata.dump();Maintain(jpeg.size()+m.size());Write(raw_/(j.key+".jpg"),reinterpret_cast<const char*>(jpeg.data()),jpeg.size());Write(raw_/(j.key+".json"),m.data(),m.size());++written_;cached_bytes_+=jpeg.size()+m.size();
   }catch(...){++failed_;/* A missing exact frame is an explicit review evidence failure, never a nearest-time substitution. */}
   try{Report();}catch(...){++failed_;}
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
  chmod(raw_.c_str(),0700);worker_=std::thread([this]{Run();});}
 ~ReviewFrameCache(){{std::lock_guard<std::mutex> l(mutex_);stop_=true;jobs_.clear();}ready_.notify_all();if(worker_.joinable())worker_.join();}
 bool Enabled(const std::string& channel){if(root_.empty())return false;std::lock_guard<std::mutex> l(mutex_);auto now=std::chrono::steady_clock::now();
  if(now-checked_>std::chrono::seconds(1)){checked_=now;try{std::ifstream f(root_/"enabled.json");f>>policy_;}catch(...){policy_=Json();}}
  if(!policy_.is_object()||!policy_.contains("expires_at")||!policy_["expires_at"].is_number_integer()||!policy_.contains("channels")||!policy_["channels"].is_array())return false;
  if(policy_["expires_at"].get<long long>()<static_cast<long long>(std::time(nullptr)))return false;
  for(auto& c:policy_.value("channels",Json::array()))if(c==channel)return true;return false;
 }
 void Offer(Json metadata,std::function<cv::Mat()> render){std::lock_guard<std::mutex> l(mutex_);if(root_.empty())return;if(jobs_.size()>=2){++dropped_;return;}
  auto text=metadata.at("channel_id").get<std::string>()+"\n"+metadata.at("stream_session_id").get<std::string>()+"\n"+metadata.at("source_pts_ns").get<std::string>()+"\n"+metadata.at("source_frame_index").get<std::string>();
  jobs_.push_back({Hash(text),std::move(metadata),std::move(render)});ready_.notify_one();}
};
inline ReviewFrameCache& SharedReviewFrameCache(){static ReviewFrameCache cache;return cache;}
}

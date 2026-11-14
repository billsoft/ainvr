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
#include <sys/statvfs.h>
#include <cstdlib>
#include <ctime>
#include <stdexcept>
#include <vector>
#include <set>
#include <unordered_map>
#include <unordered_set>
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
// Live view of the filesystem holding raw/: bytes and inodes that are still free.
struct SpoolSpace {uintmax_t total=0,free=0,free_inodes=0;};
class ReviewFrameCache {
 public:
 // The frame budget follows the spool's own filesystem. raw/ may be a small
 // memory filesystem: a fixed budget larger than it reaches ENOSPC first, the
 // consumer's 1-byte ACK files then fail as well, nothing becomes evictable and
 // the spool wedges. A quarter of it, plus a free-space reserve, stays for ACKs,
 // pins and temporaries.
 static uintmax_t SpoolCapacity(uintmax_t total){return std::min<uintmax_t>(2ULL*1024*1024*1024,total/4*3);}
 static uintmax_t SpoolReserve(uintmax_t total){return std::clamp<uintmax_t>(total/16,256*1024,64ULL*1024*1024);}
 static bool SpoolAdmits(const SpoolSpace& s,uintmax_t cached,uintmax_t incoming){
  const auto capacity=SpoolCapacity(s.total);
  return incoming<=capacity&&cached<=capacity-incoming&&s.free>=incoming+SpoolReserve(s.total)&&s.free_inodes>=kReserveInodes;
 }
 private:
 static constexpr uintmax_t kReserveInodes=1024;
 using Json=nlohmann::json;
 // Jobs waiting for storage are bounded by the 256 MiB pixel budget (82 queued
 // 1080p frames, ~5 s at 15 FPS) so a slow fsync is absorbed instead of stopping
 // inference; this count only bounds bookkeeping for tiny frames.
 static constexpr size_t queue_capacity_=96;
 static constexpr uintmax_t pixel_capacity_=256ULL*1024*1024;
 static constexpr int ttl_seconds_=30,requested_ttl_seconds_=60;
 static constexpr uintmax_t kMinFrameBytes=64*1024;
 struct Job {std::string key;Json metadata;std::function<ReviewEncodedFrame()> render;uintmax_t retained_bytes=0;std::shared_ptr<std::promise<bool>> completion;std::chrono::steady_clock::time_point admitted;};
 std::filesystem::path root_,raw_;std::atomic<uint64_t> dropped_{0},failed_{0},written_{0},evicted_{0};std::mutex mutex_;std::condition_variable ready_,space_;
 std::deque<Job> jobs_;bool stop_=false;std::thread worker_;
 std::unordered_map<std::string,uintmax_t> sizes_; // worker-only: spooled key -> jpg+json bytes
 // worker-only: owning channel and write time of each unacknowledged frame, learned
 // once (from metadata for frames of a previous process). Used only to reclaim
 // orphans of channels that are no longer captured.
 struct Origin {std::string channel;std::filesystem::file_time_type written;};
 std::unordered_map<std::string,Origin> origins_;std::atomic<uint64_t> orphan_evicted_{0};
 static constexpr auto kOrphanAge=std::chrono::hours(1);
 // Admitted frames whose observation was never published (guarded by mutex_).
 // Bounded by the queue: an entry lives only until its job completes.
 std::unordered_set<std::string> abandoned_;std::atomic<uint64_t> released_{0};
 static std::string IdentityKey(const Json& m){return Hash(m.at("channel_id").get<std::string>()+"\n"+m.at("stream_session_id").get<std::string>()+"\n"+m.at("source_pts_ns").get<std::string>()+"\n"+m.at("source_frame_index").get<std::string>());}
 // No consumer can reference an unpublished frame, so it is released like an
 // ACK'd one (TTL eviction). Not fsynced: losing it on power loss only keeps
 // the frame longer, never loses evidence that something refers to.
 void Release(const std::string& key){
  const auto path=raw_/(key+".ack");const int fd=open(path.c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NOFOLLOW,0600);
  // Empty on purpose: only the name and age of an ACK are read, and an empty
  // file costs no 64 KiB tmpfs page.
  if(fd<0)return;close(fd);++released_;
 }
 uintmax_t retained_pixel_bytes_=0;
 std::atomic<uint64_t> queue_dropped_{0},pixel_dropped_{0},invalid_dropped_{0},protected_evicted_{0};
 std::string last_report_;uintmax_t cached_bytes_=0;
 // Charged to this batch but not yet on the filesystem, so the live free space
 // does not show them yet (worker-only).
 uintmax_t staging_bytes_=0;SpoolSpace space_seen_{};
 // Bytes a file really occupies. On .190 tmpfs pages are 64 KiB: a 270-byte
 // metadata file costs 64 KiB, so apparent sizes undercount the spool by ~40%.
 uintmax_t block_=4096;
 uintmax_t Allocated(uintmax_t n) const {return (n+block_-1)/block_*block_;}
 SpoolSpace Space(){
  struct statvfs fs{};if(statvfs(raw_.c_str(),&fs)!=0)throw std::runtime_error("Evidence spool unavailable");
  if(fs.f_bsize)block_=fs.f_bsize;
  // f_files==0: the filesystem has no inode limit (tmpfs nr_inodes=0).
  SpoolSpace s{uintmax_t(fs.f_blocks)*fs.f_frsize,uintmax_t(fs.f_bavail)*fs.f_frsize,fs.f_files?uintmax_t(fs.f_favail):UINTMAX_MAX};
  s.free=s.free>staging_bytes_?s.free-staging_bytes_:0;space_seen_=s;return s;
 }
 std::chrono::steady_clock::time_point maintained_{};
 uint64_t maintenance_scans_=0;
 std::atomic<uint64_t> backpressure_waits_{0},canceled_admissions_{0};
 std::atomic<uint64_t> completed_{0},completion_total_us_{0},completion_max_us_{0},directory_syncs_{0};
 size_t active_=0; // jobs taken by the worker and not yet completed (guarded by mutex_)
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
 struct Staged {std::string key;std::vector<uint8_t> jpeg;std::string meta;
  std::array<std::filesystem::path,2> names,temp;std::array<int,2> fd{-1,-1};std::array<bool,2> opened{false,false};bool ok=false;};
 static void Discard(Staged& s){
  for(size_t i=0;i<2;++i){if(s.fd[i]>=0){close(s.fd[i]);s.fd[i]=-1;}if(s.opened[i]){std::error_code ec;std::filesystem::remove(s.temp[i],ec);s.opened[i]=false;}}
  s.ok=false;
 }
 // Stage every pair of the batch, sync all their files CONCURRENTLY (ext4 commits
 // concurrent fsyncs in one journal transaction), publish the names, then ONE
 // directory sync commits the whole batch. A receipt still requires both of its
 // own file syncs plus that directory sync; consumers see a frame only after it.
 // Per-frame syncs (3 per frame) capped durable evidence near 15 frames/s on .190.
 void WriteFrames(std::vector<Staged>& batch){
  for(auto& s:batch){
   s.names={raw_/(s.key+".jpg"),raw_/(s.key+".json")};s.temp=s.names;for(auto& path:s.temp)path+=".tmp";
   const std::array<const char*,2> data{reinterpret_cast<const char*>(s.jpeg.data()),s.meta.data()};
   const std::array<size_t,2> sizes{s.jpeg.size(),s.meta.size()};
   try{
    for(size_t i=0;i<2;++i){
     s.fd[i]=open(s.temp[i].c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NOFOLLOW,0600);
     if(s.fd[i]<0)throw std::runtime_error("evidence pair open");s.opened[i]=true;
     size_t at=0;while(at<sizes[i]){const auto n=write(s.fd[i],data[i]+at,sizes[i]-at);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("evidence pair write");at+=size_t(n);}
    }
    s.ok=true;
   }catch(...){Discard(s);}
  }
  std::vector<std::pair<Staged*,std::future<bool>>> syncs;
  for(auto& s:batch)if(s.ok)for(const int fd:s.fd)syncs.emplace_back(&s,std::async(std::launch::async,[fd]{return fsync(fd)==0;}));
  for(auto& [owner,sync]:syncs)if(!sync.get())owner->ok=false;
  bool published=false;
  for(auto& s:batch){
   if(!s.ok){Discard(s);continue;}
   bool closed=true;for(auto& fd:s.fd){const int closing=fd;fd=-1;if(close(closing))closed=false;}
   if(!closed){Discard(s);continue;}
   try{for(size_t i=0;i<2;++i)std::filesystem::rename(s.temp[i],s.names[i]);published=true;}catch(...){Discard(s);}
  }
  if(!published)return;
  ++directory_syncs_;
  const int dir=open(raw_.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);
  const bool synced=dir>=0&&fsync(dir)==0;if(dir>=0)close(dir);
  if(!synced)for(auto& s:batch)s.ok=false;
 }
 void RefreshPolicy(){
  const auto now=std::chrono::steady_clock::now();if(now-checked_<std::chrono::seconds(1))return;checked_=now;
  Json next;try{std::ifstream f(root_/"enabled.json");f>>next;}catch(...){return;}
  std::lock_guard<std::mutex> lock(mutex_);policy_=std::move(next);
 }
 // A zero `incoming` only maintains (idle tick); a frame is admitted only when the
 // budget AND the live free space (minus the ACK/pin reserve) can take it.
 void Admit(uintmax_t incoming){
  if(incoming&&!SpoolAdmits(Space(),cached_bytes_,incoming))throw std::runtime_error("Evidence spool capacity exhausted");
 }
 void Maintain(uintmax_t incoming){
  const auto tick=std::chrono::steady_clock::now();
  // Only this worker creates evidence. Keep a conservative byte total between
  // scans; ACKs/pins are consulted afresh during each cleanup. Never evict an
  // unacknowledged or pinned frame to make room for a new one.
  if(maintained_.time_since_epoch().count()!=0 && tick-maintained_<std::chrono::seconds(1)){Admit(incoming);return;}
  ++maintenance_scans_;Space(); // block size before sizing files from a previous process
  const auto now=std::filesystem::file_time_type::clock::now();
  // One name-only directory pass per scan. Sizes of frames this worker wrote are
  // remembered (sizes_); only files from before this process are stat'ed, once.
  // Per-file stat calls on every scan made this sole worker stat-bound (measured:
  // ~17k newfstatat/s with ~6k spooled frames), which throttled durable evidence
  // to ~10 frames/s and, through admission backpressure, the inference loop.
  std::unordered_set<std::string> jpgs,acks,retained;
  for(const auto& e:std::filesystem::directory_iterator(raw_)){
   const auto& path=e.path();const auto ext=path.extension();std::error_code ec;
   if(ext==".jpg"){if(e.is_regular_file(ec))jpgs.insert(path.stem().string());}
   else if(ext==".ack")acks.insert(path.stem().string());
   // Unacknowledged frames and checkpoint-owned frames never expire. A bounded
   // full spool reports admission failure instead of deleting pending evidence.
   else if(ext==".pin")retained.insert(path.filename().string().substr(0,64));
  }
  for(auto it=sizes_.begin();it!=sizes_.end();)it=jpgs.count(it->first)?std::next(it):sizes_.erase(it);
  for(auto it=origins_.begin();it!=origins_.end();)it=jpgs.count(it->first)&&!acks.count(it->first)?std::next(it):origins_.erase(it);
  uintmax_t size=0;
  for(const auto& key:jpgs){
   auto it=sizes_.find(key);
   if(it==sizes_.end()){
    std::error_code ec;uintmax_t n=0;
    const auto jpg=std::filesystem::file_size(raw_/(key+".jpg"),ec);if(!ec)n+=Allocated(jpg);
    const auto meta=std::filesystem::file_size(raw_/(key+".json"),ec);if(!ec)n+=Allocated(meta);
    it=sizes_.emplace(key,n).first;
   }
   size+=it->second;
  }
  for(const auto& key:acks){
   if(retained.count(key)||!jpgs.count(key))continue;
   const auto ack=raw_/(key+".ack");std::error_code ec;
   const auto acked=std::filesystem::last_write_time(ack,ec);
   if(ec||now-acked<std::chrono::seconds(ttl_seconds_))continue;
   std::filesystem::remove(raw_/(key+".jpg"));std::filesystem::remove(raw_/(key+".json"));std::filesystem::remove(ack);
   const auto n=sizes_[key];size=size>n?size-n:0;sizes_.erase(key);++evicted_;
  }
  // Orphans: a channel deleted while its last observation was still journaled
  // leaves a frame no consumer will ever ACK. A captured channel's frames, and
  // pinned frames, never expire unacknowledged (the consumer may be down).
  std::unordered_set<std::string> captured;
  {std::lock_guard<std::mutex> lock(mutex_);const auto c=policy_.is_object()?policy_.find("channels"):policy_.end();
   if(c!=policy_.end()&&c->is_array())for(const auto& v:*c)if(v.is_string())captured.insert(v.get<std::string>());}
  for(const auto& key:jpgs){
   if(acks.count(key)||retained.count(key))continue;
   auto it=origins_.find(key);
   if(it==origins_.end()){
    const auto meta=raw_/(key+".json");std::error_code ec;
    const auto written=std::filesystem::last_write_time(meta,ec);const auto bytes=std::filesystem::file_size(meta,ec);
    if(ec||bytes>65536)continue; // unknown origin: never guess, keep it
    Origin origin{{},written};
    try{std::ifstream in(meta);origin.channel=Json::parse(in).at("channel_id").get<std::string>();}catch(...){continue;}
    it=origins_.emplace(key,std::move(origin)).first;
   }
   if(captured.count(it->second.channel)||now-it->second.written<kOrphanAge)continue;
   std::error_code ec;std::filesystem::remove(raw_/(key+".jpg"),ec);std::filesystem::remove(raw_/(key+".json"),ec);
   const auto n=sizes_[key];size=size>n?size-n:0;sizes_.erase(key);origins_.erase(it);++orphan_evicted_;
  }
  cached_bytes_=size;maintained_=tick;
  Admit(incoming);
 }
 void Report(){const auto tick=std::chrono::steady_clock::now();if(tick-reported_<std::chrono::seconds(1))return;reported_=tick;try{Space();}catch(...){}size_t queued;uintmax_t pixels;{std::lock_guard<std::mutex> lock(mutex_);queued=jobs_.size();pixels=retained_pixel_bytes_;}const auto stats=Json{{"backpressure_waits",backpressure_waits_.load()},{"canceled_admissions",canceled_admissions_.load()},{"completion_count",completed_.load()},{"completion_mean_ms",completed_.load()?double(completion_total_us_.load())/completed_.load()/1000:0},{"completion_max_ms",double(completion_max_us_.load())/1000},{"maintenance_scans",maintenance_scans_},{"written",written_.load()},{"dropped",dropped_.load()},{"queue_full_dropped",queue_dropped_.load()},{"pixel_budget_dropped",pixel_dropped_.load()},{"invalid_dropped",invalid_dropped_.load()},{"failed",failed_.load()},{"render_encode_or_cache_failed",failed_.load()},{"evicted",evicted_.load()},{"orphan_evicted",orphan_evicted_.load()},{"directory_syncs",directory_syncs_.load()},{"unpublished_released",released_.load()},{"protected_evicted",protected_evicted_.load()},{"cached_bytes",cached_bytes_},{"max_bytes",SpoolCapacity(space_seen_.total)},{"spool_total_bytes",space_seen_.total},{"spool_free_bytes",space_seen_.free},{"queued",queued},{"queue_capacity",queue_capacity_},{"retained_pixel_bytes",pixels},{"max_retained_pixel_bytes",pixel_capacity_},{"ttl_seconds",ttl_seconds_},{"requested_ttl_seconds",requested_ttl_seconds_}}.dump();if(stats==last_report_)return;Write(root_/"cache-status.json",stats.data(),stats.size());last_report_=stats;}
 void Run(){
  for(;;){
   std::vector<Job> jobs;
   {std::unique_lock<std::mutex> l(mutex_);
    if(!ready_.wait_for(l,std::chrono::seconds(1),[&]{return stop_||!jobs_.empty();})){l.unlock();try{RefreshPolicy();Maintain(0);Report();}catch(...){++failed_;}continue;}
    if(stop_&&jobs_.empty())return;
    // Take everything already queued. In-flight jobs still count against the
    // queue bound (active_), so batching never admits more frames than before.
    while(!jobs_.empty()){jobs.push_back(std::move(jobs_.front()));jobs_.pop_front();}
    active_+=jobs.size();}
   std::vector<Staged> staged;std::vector<int> slot(jobs.size(),-1);std::vector<char> charged(jobs.size(),0);
   staged.reserve(jobs.size());
   for(size_t i=0;i<jobs.size();++i){
    auto& j=jobs[i];
    try{
     // Unacknowledged evidence never expires. Learn about a saturated spool from the
     // throttled scan BEFORE encoding: a frame that cannot be stored must not cost an
     // encode, and must not force another directory scan (one per job saturated the
     // only worker and, through admission backpressure, the inference loop).
     Maintain(kMinFrameBytes);
     auto image=j.render();auto& jpeg=image.jpeg;
     if(image.width<=0||image.height<=0||jpeg.size()<4||jpeg.size()>8ULL*1024*1024||jpeg[0]!=255||jpeg[1]!=216||jpeg[jpeg.size()-2]!=255||jpeg.back()!=217)throw std::runtime_error("evidence encode");
     j.metadata["image_width"]=image.width;j.metadata["image_height"]=image.height;
     j.metadata["schema_version"]=2;j.metadata["bytes"]=jpeg.size();j.metadata["sha256"]=Hash(std::string(reinterpret_cast<const char*>(jpeg.data()),jpeg.size()));
     auto m=j.metadata.dump();const auto bytes=Allocated(jpeg.size())+Allocated(m.size());Maintain(bytes);cached_bytes_+=bytes;staging_bytes_+=bytes;charged[i]=1;
     Staged entry;entry.key=j.key;entry.jpeg=std::move(jpeg);entry.meta=std::move(m);
     slot[i]=int(staged.size());staged.push_back(std::move(entry));
    }catch(...){/* counted at completion below */}
    // Drop the raw FrameRef as soon as it is encoded.
    j.render={};
   }
   if(!staged.empty())try{WriteFrames(staged);}catch(...){for(auto& st:staged)Discard(st);}
   staging_bytes_=0; // written (now in the live free space) or discarded
   for(size_t i=0;i<jobs.size();++i){
    auto& j=jobs[i];bool saved=false;
    if(slot[i]>=0&&staged[slot[i]].ok){const auto& st=staged[slot[i]];sizes_[j.key]=Allocated(st.jpeg.size())+Allocated(st.meta.size());
     origins_[j.key]=Origin{j.metadata.value("channel_id",std::string()),std::filesystem::file_time_type::clock::now()};++written_;saved=true;}
    else{++failed_;if(charged[i])maintained_={};/* Resync only after bytes were charged but not stored. A missing exact frame is an explicit review evidence failure, never a nearest-time substitution. */}
    bool abandoned=false;
    // Resolve the receipt under the same lock Abandon() inspects it with: either it
    // sees the job unfinished (and this erase will find its key) or already resolved.
    {std::lock_guard<std::mutex> lock(mutex_);retained_pixel_bytes_-=j.retained_bytes;--active_;abandoned=abandoned_.erase(j.key)>0;j.completion->set_value(saved);}space_.notify_all();
    if(saved&&abandoned)Release(j.key);
    const auto us=uint64_t(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now()-j.admitted).count());
    ++completed_;completion_total_us_+=us;completion_max_us_=std::max(completion_max_us_.load(),us);
   }
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
 bool FullResolution(const std::string& channel){std::lock_guard<std::mutex> l(mutex_);
  if(!policy_.is_object()||!policy_.contains("vehicle_channels")||!policy_["vehicle_channels"].is_array())return false;
  for(const auto& c:policy_["vehicle_channels"])if(c==channel)return true;return false;
 }
 bool Enabled(const std::string& channel){if(root_.empty())return false;std::lock_guard<std::mutex> l(mutex_);
  if(!policy_.is_object()||!policy_.contains("expires_at")||!policy_["expires_at"].is_number_integer()||!policy_.contains("channels")||!policy_["channels"].is_array())return false;
  // Last committed desired configuration survives a database outage.
  // Explicit removal from channels disables capture; a lease timeout cannot.
  for(auto& c:policy_.value("channels",Json::array()))if(c==channel)return true;return false;
 }
 // Region absence and recovery are proved by the scene, including an empty
 // scene. Keep the existing target-only budget on channels without region rules.
 bool NeedsFrame(const std::string& channel,const FrameResult& result){
  if(HasReviewVisualTarget(result))return true;
  if(root_.empty())return false;
  std::lock_guard<std::mutex> lock(mutex_);
  if(!policy_.is_object())return false;
  const auto channels=policy_.find("region_channels");
  if(channels==policy_.end()||!channels->is_array())return false;
  return std::any_of(channels->begin(),channels->end(),[&](const Json& c){return c.is_string()&&c==channel;});
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
   // One job in work plus queue_capacity_ waiting, exactly as before batching.
   const auto queue_full=[&]{return jobs_.size()+(active_?active_-1:0)>=queue_capacity_;};
   const auto full=[&]{return queue_full()||retained_bytes>pixel_capacity_-std::min(pixel_capacity_,retained_pixel_bytes_);};
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
   if(queue_full()){++dropped_;++queue_dropped_;return reject();}
   if(retained_bytes>pixel_capacity_-std::min(pixel_capacity_,retained_pixel_bytes_)){++dropped_;++pixel_dropped_;return reject();}
   jobs_.push_back({key,std::move(metadata),std::move(render),retained_bytes,completion,std::chrono::steady_clock::now()});retained_pixel_bytes_+=retained_bytes;ready_.notify_one();}
   return done;
  }catch(...){++dropped_;++invalid_dropped_;return reject();}
 }
 // The caller could not publish an observation for this admitted frame (journal
 // full, channel stopping, no journal). Without this, the frame is never
 // acknowledged and, never expiring, fills the spool (measured on .190: the
 // spool refilled 2 GiB within ~25 minutes of cleanup).
 void Abandon(const Json& metadata,const std::shared_future<bool>& receipt){
  if(root_.empty()||!receipt.valid())return;
  std::string key;try{key=IdentityKey(metadata);}catch(...){return;}
  {std::lock_guard<std::mutex> l(mutex_);
   if(receipt.wait_for(std::chrono::seconds(0))!=std::future_status::ready){abandoned_.insert(key);return;}}
  bool saved=false;try{saved=receipt.get();}catch(...){}
  if(saved)Release(key);
 }
 // Compatibility for synchronous callers/tests. The live channel uses OfferAsync.
 bool Offer(Json metadata,std::function<cv::Mat()> render,size_t retained_bytes=0){
  return OfferAsync(std::move(metadata),std::move(render),retained_bytes).get();
 }
};
inline ReviewFrameCache& SharedReviewFrameCache(){static ReviewFrameCache cache;return cache;}
}

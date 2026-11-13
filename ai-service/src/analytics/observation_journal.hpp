// AINVR. Ordered, bounded board-local journal of unified observations; no alarm logic.
#pragma once
#include "../output/archive_executor.hpp"
#include "../output/result.hpp"
#include "region_observation_capabilities.hpp"
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <limits>
#include <cmath>
#include <mutex>
#include <string_view>
#include <chrono>
#include <memory>
#include <thread>
#include <array>
#include <atomic>
#include <functional>
#include <future>
#include <vector>
#include <deque>
namespace ai_service::analytics {
// Process-wide stall diagnostics for the synchronous journal path (inference thread).
struct ObservationJournalDiag {
  std::atomic<uint64_t> state_writes{0},state_over_250ms{0},state_over_1000ms{0},state_max_ms{0};
  std::atomic<uint64_t> async_failures{0};
  std::atomic<uint64_t> record_writes{0},record_over_250ms{0},record_over_1000ms{0},record_max_ms{0};
  void Note(bool state,double ms) noexcept {
    auto& writes=state?state_writes:record_writes;auto& o250=state?state_over_250ms:record_over_250ms;
    auto& o1000=state?state_over_1000ms:record_over_1000ms;auto& mx=state?state_max_ms:record_max_ms;
    writes.fetch_add(1,std::memory_order_relaxed);if(ms>250)o250.fetch_add(1,std::memory_order_relaxed);
    if(ms>1000)o1000.fetch_add(1,std::memory_order_relaxed);
    auto cur=mx.load(std::memory_order_relaxed);const auto now=uint64_t(ms);
    while(now>cur&&!mx.compare_exchange_weak(cur,now,std::memory_order_relaxed)){}
  }
};
inline ObservationJournalDiag& JournalDiag() noexcept {static ObservationJournalDiag d;return d;}
class ObservationJournal {
 public:
  static std::string Hash(const std::string& value) {
    unsigned char bytes[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(value.data()),value.size(),bytes);
    std::ostringstream out;for(auto b:bytes)out<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b);return out.str();
  }
  ObservationJournal(const std::string& root,const std::string& channel,size_t max_bytes=64*1024*1024,size_t max_records=10000,uintmax_t min_free_bytes=uintmax_t(2)*1024*1024*1024,std::function<void()> before_write={})
    :path_(std::filesystem::path(root)/Hash(channel)),channel_(channel),max_bytes_(max_bytes),max_records_(max_records),min_free_bytes_(min_free_bytes) {
    before_write_=std::move(before_write);
    if(!std::filesystem::path(root).is_absolute()||channel.empty()||channel.size()>256)throw std::invalid_argument("Invalid observation journal location");
    std::filesystem::create_directories(path_);
    if(std::filesystem::is_symlink(path_)||!std::filesystem::is_directory(path_))throw std::runtime_error("Invalid observation journal directory");
    if(chmod(path_.c_str(),0700))throw std::runtime_error("Observation journal permissions failed");
    lock_=open((path_/".writer-lock").c_str(),O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);
    if(lock_<0)throw std::runtime_error("Observation journal lock failed");
    if(flock(lock_,LOCK_EX|LOCK_NB)){close(lock_);lock_=-1;throw std::runtime_error("Observation journal already owned");}
    try{
      const auto state=path_/"producer.json";
      if(std::filesystem::exists(state)){
        std::ifstream input(state);nlohmann::json saved;input>>saved;
        if(saved.at("channel_id")!=channel_||saved.at("schema_version")!="1.0")throw std::runtime_error("Observation identity mismatch");
        producer_=saved.at("producer_id").get<std::string>();
        const auto text=saved.at("next_offset").get<std::string>();size_t used=0;next_=std::stoull(text,&used);
        if(used!=text.size()||text!=std::to_string(next_.load())||producer_.size()!=64)throw std::runtime_error("Invalid observation identity");
      }else{
        // Never invent a new producer identity over orphaned pending records.
        for(const auto& entry:std::filesystem::directory_iterator(path_))if(IsRecord(entry.path()))throw std::runtime_error("Observation identity missing");
        unsigned char seed[32];if(RAND_bytes(seed,sizeof(seed))!=1)throw std::runtime_error("Observation identity generation failed");
        producer_=Hash(std::string(reinterpret_cast<char*>(seed),sizeof(seed)));SaveState();
      }
    // This process owns the writer lock, so any temp file is a leftover of a crashed write.
    for(const auto& entry:std::filesystem::directory_iterator(path_))if(IsTemp(entry.path())){std::error_code ignored;std::filesystem::remove(entry.path(),ignored);}
    RefreshUsage();
    writer_=std::make_unique<output::ArchiveExecutor>(1,256);
    }catch(...){close(lock_);lock_=-1;throw;}
  }
  ~ObservationJournal(){writer_.reset();if(lock_>=0)close(lock_);}
  ObservationJournal(const ObservationJournal&)=delete;
  ObservationJournal& operator=(const ObservationJournal&)=delete;
  // Validates and accounts synchronously (cheap), then hands the DURABLE write to one
  // FIFO writer thread so an eMMC fsync stall never blocks the inference thread.
  // Offsets are reserved by the writer, in order, with the unchanged on-disk sequence
  // (reserve -> SaveState -> record write); queued-but-unwritten records leave no gap.
  // A full queue blocks (backpressure), never drops. Write failures are counted in
  // Status().async_failures and leave the documented visible offset gap.
  void Stage(const FrameResult& result,std::shared_future<bool> evidence={}) {
    std::unique_lock guard(mutex_);
    if(result.channel_id!=channel_||result.frame_pts_ns<0||result.frame_index<0||!std::isfinite(result.timestamp))throw std::invalid_argument("Invalid observation source");
    const auto& analytics=result.model_extra.at("analytics");
    const bool detection_only=analytics.at("status")=="detection_only";
    if(analytics.at("status")!="active"&&!detection_only)throw std::invalid_argument("Observation result unavailable");
    if(next_.load()==std::numeric_limits<uint64_t>::max())throw std::runtime_error("Observation offset exhausted");
    nlohmann::json value={{"schema_version","1.0"},{"producer_id",producer_},{"offset","00000000000000000000"},
      {"channel_id",channel_},{"stream_url",result.stream_url},{"stream_session_id",analytics.at("stream_session_id")},
      {"source_pts_ns",std::to_string(result.frame_pts_ns)},{"source_frame_index",std::to_string(result.frame_index)},
      {"timestamp",result.timestamp},{"width",result.frame_width},{"height",result.frame_height},
      {"model",{{"id",result.model_name},{"label_catalog",result.model_extra.at("label_catalog")}}},
      {"tracks",analytics.at("tracks")}};
    if(result.model_extra.contains("compatible_label_catalogs"))value["model"]["compatible_label_catalogs"]=result.model_extra.at("compatible_label_catalogs");
    const auto capabilities=RegionObservationCapabilities(result);
    if(!capabilities.empty())value["region_observations"]=capabilities;
    // Attributes belong to this exact observed target, never copied to lost/predicted tracks.
    for(auto& t:value["tracks"])if(t.value("observation",std::string())=="detected"){
      for(const auto& d:result.detections)if(!d.track_id.empty()&&t.at("track_id")==d.track_id){
        if(d.model_extra.contains("attributes"))t["attributes"]=d.model_extra.at("attributes");
        if(d.model_extra.contains("source_node"))t["source_node"]=d.model_extra.at("source_node");
        break;
      }
    }
    if(analytics.value("continuity_gap",false))value["gap"]=true;
    if(result.model_extra.contains("evidence_delivery"))value["evidence_delivery"]=result.model_extra.at("evidence_delivery");
    // Reserve the longest delivery state before byte admission. Pending is
    // internal only; it is NEVER written into the consumer protocol.
    if(evidence.valid())value["evidence_delivery"]={{"schema_version",2},{"state","pending"}};
    value["observation_mode"]=detection_only?"detections":"tracks";
    if(detection_only) {
      value["detections"]=nlohmann::json::array();
      // Only exported detections: hidden low-confidence candidates cannot alarm.
      for(const auto& d:result.detections) {
        nlohmann::json detection={
        {"label_id",d.label_id.empty()?"class:"+std::to_string(d.class_id):d.label_id},
        {"bbox",{{"x",d.bbox[0]},{"y",d.bbox[1]},{"w",d.bbox[2]},{"h",d.bbox[3]}}}};
        if(d.model_extra.contains("attributes"))detection["attributes"]=d.model_extra.at("attributes");
        if(d.model_extra.contains("source_node"))detection["source_node"]=d.model_extra.at("source_node");
        value["detections"].push_back(std::move(detection));
      }
    }
    // The placeholder offset has the maximum width, so this size is an upper bound.
    size_t bound=value.dump().size();
    if(bound>1024*1024){
      // Optional dense attributes must not break existing counting/trajectory
      // delivery. Omit them as an explicitly unknown capability, not as a
      // negative pose observation, while retaining every original target box.
      size_t omitted=0;
      for(const auto* field:{"tracks","detections"})if(value.contains(field))
        for(auto& row:value[field])omitted+=row.erase("attributes");
      if(omitted){
        value["attribute_delivery"]={{"state","omitted"},{"reason","observation_capacity"},{"targets",omitted}};
        if(value.contains("region_observations")&&value["region_observations"].contains("suspected_down")){
          value["region_observations"]["suspected_down"]["state"]="unknown";
          value["region_observations"]["suspected_down"]["reason"]="attribute_capacity";
        }
        bound=value.dump().size();
      }
    }
    if(bound>1024*1024)throw std::runtime_error("Observation record capacity exceeded");
    // Only this locked producer can add files; the consumer can only delete.
    // Cached usage is therefore a conservative upper bound (records still queued are
    // included). Recount only when near capacity, with bounded retries.
    if(usage_records_>=max_records_||bound>max_bytes_-std::min(max_bytes_,usage_bytes_)){
      if(std::chrono::steady_clock::now()-usage_checked_>=std::chrono::seconds(1))RefreshUsage();
      if(usage_records_>=max_records_||bound>max_bytes_-std::min(max_bytes_,usage_bytes_)){
        ++full_rejections_;throw std::runtime_error("Observation journal full");
      }
    }
    // Per-channel caps alone cannot protect eMMC when many channels are enabled.
    // Fail closed before queueing, keeping OS/parameter headroom.
    std::error_code space_error;
    const auto space=std::filesystem::space(path_,space_error);
    if(space_error || space.available<min_free_bytes_ || bound>space.available-min_free_bytes_){
      ++full_rejections_;throw std::runtime_error("Observation journal storage reserve reached");
    }
    // Count before writing: even a rename followed by a failed directory fsync
    // may leave a record. An overestimate cannot exceed the storage bound.
    ++usage_records_;usage_bytes_+=bound;inflight_records_.fetch_add(1);inflight_bytes_.fetch_add(bound);
    // Hand the record to the writer FIFO in Stage order (still under the producer
    // lock), so records that arrive while the writer is busy form the next batch.
    auto record=std::make_shared<nlohmann::json>(std::move(value));
    {std::lock_guard q(queue_mutex_);queue_.push_back({record,bound,std::move(evidence)});}
    guard.unlock();
    // One task per record keeps the executor bound as the backpressure limit: a full
    // queue blocks here, never drops. A task finding its record already committed by
    // an earlier batch returns at once. Exceptions/broken receipts cannot claim
    // durability (DrainQueue).
    try{
      writer_->Submit([this]{DrainQueue();});
    }catch(...){
      bool removed=false;
      {std::lock_guard q(queue_mutex_);for(auto it=queue_.begin();it!=queue_.end();++it)if(it->record==record){queue_.erase(it);removed=true;break;}}
      // Not found: an earlier task already took it and will account for it.
      if(removed){inflight_records_.fetch_sub(1);inflight_bytes_.fetch_sub(bound);}
      throw;
    }
  }
  // Waits until every queued record has been durably written or failed (tests, shutdown).
  bool Flush(std::chrono::milliseconds timeout=std::chrono::seconds(30)) const {
    const auto end=std::chrono::steady_clock::now()+timeout;
    while(inflight_records_.load()!=0){if(std::chrono::steady_clock::now()>end)return false;std::this_thread::sleep_for(std::chrono::milliseconds(1));}
    return true;
  }
  nlohmann::json Status() const {std::lock_guard guard(mutex_);return {{"producer_id",producer_},{"next_offset",std::to_string(next_.load())},{"staged",staged_.load()},{"pending_upper_bound",usage_records_},{"bytes_upper_bound",usage_bytes_},{"full_rejections",full_rejections_},{"queued",inflight_records_.load()},{"async_failures",async_failures_.load()},{"write_batches",write_batches_.load()}};}
 private:
  static bool IsRecord(const std::filesystem::path& path){const auto name=path.filename().string();return name.size()==25&&name.substr(20)==".json"&&name.find_first_not_of("0123456789")>=20;}
  struct Queued {std::shared_ptr<nlohmann::json> record;size_t bound=0;std::shared_future<bool> evidence;};
  // Writer-thread only (single FIFO worker).
  void DrainQueue(){
    std::vector<Queued> batch;
    {std::lock_guard q(queue_mutex_);batch.assign(std::make_move_iterator(queue_.begin()),std::make_move_iterator(queue_.end()));queue_.clear();}
    if(batch.empty())return;
    // Receipts are awaited in order: a later frame never overtakes a pending one.
    // Exceptions/broken receipts cannot claim durability.
    for(auto& q:batch)if(q.evidence.valid()){
      bool durable=false;try{durable=q.evidence.get();}catch(...){}
      (*q.record)["evidence_delivery"]={{"schema_version",2},{"state",durable?"durable":"failed"}};
    }
    WriteRecords(batch);
    for(const auto& q:batch){inflight_records_.fetch_sub(1);inflight_bytes_.fetch_sub(q.bound);}
  }
  // Same on-disk protocol as the per-record path, committed per batch: offsets are
  // reserved in FIFO order and saved (producer.json) BEFORE any record of the batch
  // is written, so the state is never behind a record; every record is fsynced
  // (concurrently: ext4 commits concurrent fsyncs together) and renamed in order;
  // ONE directory sync then commits the batch. A failure leaves the documented
  // visible offset gap. Four syncs per record capped the journal near 15/s on .190.
  void WriteRecords(std::vector<Queued>& batch){
    struct Out {std::string data;std::filesystem::path target,temp;int fd=-1;bool ok=false;};
    std::vector<Out> outs;outs.reserve(batch.size());
    size_t failures=0;
    try{
      if(before_write_)before_write_();
      std::lock_guard io(io_mutex_);
      uint64_t offset=next_.load();
      for(auto& q:batch){
        try{
          if(offset==std::numeric_limits<uint64_t>::max())throw std::runtime_error("Observation offset exhausted");
          (*q.record)["offset"]=std::to_string(offset);
          auto data=q.record->dump();if(data.size()>1024*1024)throw std::runtime_error("Observation record capacity exceeded");
          std::ostringstream name;name<<std::setw(20)<<std::setfill('0')<<offset<<".json";
          Out out;out.data=std::move(data);out.target=path_/name.str();out.temp=out.target;out.temp+=".writer-tmp";
          outs.push_back(std::move(out));++offset;
        }catch(...){++failures;}
      }
      if(outs.empty()){Fail(failures);return;}
      ++write_batches_;
      next_.store(offset);
      {const auto t0=std::chrono::steady_clock::now();SaveState(); // Only accepted records reserve offsets durably.
        JournalDiag().Note(true,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count());}
      const auto t0=std::chrono::steady_clock::now();
      for(auto& out:outs){
        out.fd=open(out.temp.c_str(),O_CREAT|O_TRUNC|O_WRONLY|O_CLOEXEC|O_NOFOLLOW,0600);
        if(out.fd<0)continue;
        size_t at=0;out.ok=true;
        while(at<out.data.size()){const auto n=write(out.fd,out.data.data()+at,out.data.size()-at);if(n<=0){out.ok=false;break;}at+=size_t(n);}
      }
      // Bounded concurrency: at most 16 syncing threads however large the backlog.
      std::atomic<size_t> next{0};
      const auto sync=[&]{for(size_t i;(i=next.fetch_add(1))<outs.size();)if(outs[i].ok)outs[i].ok=fsync(outs[i].fd)==0;};
      // A thread that cannot start only shrinks the pool: this thread finishes the
      // remaining syncs (shared index) and every started thread is joined.
      {std::vector<std::thread> pool;const size_t n=std::min<size_t>(16,outs.size());
       try{for(size_t i=1;i<n;++i)pool.emplace_back(sync);}catch(...){}
       sync();for(auto& t:pool)t.join();}
      bool published=false;
      for(auto& out:outs){
        if(out.fd>=0&&close(out.fd))out.ok=false;out.fd=-1;
        // A failed write must not leave an unaccounted temp file on the eMMC.
        if(out.ok){try{std::filesystem::rename(out.temp,out.target);published=true;}catch(...){out.ok=false;}}
        if(!out.ok){std::error_code ignored;std::filesystem::remove(out.temp,ignored);++failures;}
      }
      if(published){
        try{SyncDirectory();}
        catch(...){for(auto& out:outs)if(out.ok){out.ok=false;++failures;}}
      }
      size_t written=0;for(const auto& out:outs)written+=out.ok;
      staged_+=written;
      JournalDiag().Note(false,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count());
      Fail(failures);
    }catch(...){
      for(auto& out:outs){if(out.fd>=0)close(out.fd);std::error_code ignored;std::filesystem::remove(out.temp,ignored);}
      Fail(batch.size());
    }
  }
  void Fail(size_t n){
    if(!n)return;async_failures_+=n;JournalDiag().async_failures.fetch_add(n,std::memory_order_relaxed);
  }
  void RefreshUsage(){
    size_t bytes=0,count=0;
    // Temp files count too: they occupy the same bytes as records until removed.
    for(const auto& entry:std::filesystem::directory_iterator(path_))if(IsRecord(entry.path())||IsTemp(entry.path())){
      std::error_code error;const auto size=entry.file_size(error);
      if(!error){bytes+=size;++count;}
      else if(error!=std::errc::no_such_file_or_directory)throw std::runtime_error("Observation journal scan failed");
    }
    // Records still queued are not on disk yet but already reserve capacity.
    usage_bytes_=bytes+inflight_bytes_.load();usage_records_=count+inflight_records_.load();usage_checked_=std::chrono::steady_clock::now();
  }
  void SyncDirectory(){const int fd=open(path_.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);if(fd<0)throw std::runtime_error("Journal directory open failed");const int code=fsync(fd);close(fd);if(code)throw std::runtime_error("Journal directory sync failed");}
  void AtomicWrite(const std::filesystem::path& target,const std::string& data){
    auto temp=target;temp+=".writer-tmp";
    const int fd=open(temp.c_str(),O_CREAT|O_TRUNC|O_WRONLY|O_CLOEXEC|O_NOFOLLOW,0600);
    if(fd<0)throw std::runtime_error("Journal write unavailable");
    size_t offset=0;bool ok=true;
    while(offset<data.size()){const auto n=write(fd,data.data()+offset,data.size()-offset);if(n<=0){ok=false;break;}offset+=size_t(n);}
    if(ok)ok=fsync(fd)==0;
    const int closed=close(fd);
    // A failed write must not leave an unaccounted temp file on the eMMC.
    if(!ok||closed){std::error_code ignored;std::filesystem::remove(temp,ignored);throw std::runtime_error("Journal write not durable");}
    try{std::filesystem::rename(temp,target);}
    catch(...){std::error_code ignored;std::filesystem::remove(temp,ignored);throw;}
    SyncDirectory();
  }
  static bool IsTemp(const std::filesystem::path& path){
    const auto name=path.filename().string();constexpr std::string_view suffix=".writer-tmp";
    return name.size()>suffix.size()&&name.compare(name.size()-suffix.size(),suffix.size(),suffix)==0;
  }
  void SaveState(){AtomicWrite(path_/"producer.json",nlohmann::json({{"schema_version","1.0"},{"channel_id",channel_},{"producer_id",producer_},{"next_offset",std::to_string(next_.load())}}).dump());}
  std::filesystem::path path_;std::string channel_,producer_;size_t max_bytes_,max_records_;uintmax_t min_free_bytes_;
  size_t usage_bytes_=0,usage_records_=0;uint64_t full_rejections_=0;
  std::chrono::steady_clock::time_point usage_checked_;
  std::atomic<uint64_t> next_{0},staged_{0},async_failures_{0},write_batches_{0};
  std::mutex queue_mutex_;std::deque<Queued> queue_; // records handed to the writer, FIFO
  std::atomic<size_t> inflight_records_{0},inflight_bytes_{0};
  int lock_=-1;mutable std::mutex mutex_,io_mutex_;
  std::function<void()> before_write_; // test seam: gate the writer thread
  std::unique_ptr<output::ArchiveExecutor> writer_; // drained before the flock is released
};
}

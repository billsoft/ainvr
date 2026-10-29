// AINVR. Ordered, bounded board-local journal of unified observations; no alarm logic.
#pragma once
#include "../output/archive_executor.hpp"
#include "../output/result.hpp"
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
  void Stage(const FrameResult& result) {
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
    value["observation_mode"]=detection_only?"detections":"tracks";
    if(detection_only) {
      value["detections"]=nlohmann::json::array();
      // Only exported detections: hidden low-confidence candidates cannot alarm.
      for(const auto& d:result.detections) value["detections"].push_back({
        {"label_id",d.label_id.empty()?"class:"+std::to_string(d.class_id):d.label_id},
        {"bbox",{{"x",d.bbox[0]},{"y",d.bbox[1]},{"w",d.bbox[2]},{"h",d.bbox[3]}}}});
    }
    // The placeholder offset has the maximum width, so this size is an upper bound.
    const size_t bound=value.dump().size();if(bound>1024*1024)throw std::runtime_error("Observation record capacity exceeded");
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
    guard.unlock();
    auto record=std::make_shared<nlohmann::json>(std::move(value));
    // Blocks only when the bounded queue is full (backpressure).
    try{
      writer_->Submit([this,record,bound]{WriteRecord(*record);inflight_records_.fetch_sub(1);inflight_bytes_.fetch_sub(bound);});
    }catch(...){inflight_records_.fetch_sub(1);inflight_bytes_.fetch_sub(bound);throw;}
  }
  // Waits until every queued record has been durably written or failed (tests, shutdown).
  bool Flush(std::chrono::milliseconds timeout=std::chrono::seconds(30)) const {
    const auto end=std::chrono::steady_clock::now()+timeout;
    while(inflight_records_.load()!=0){if(std::chrono::steady_clock::now()>end)return false;std::this_thread::sleep_for(std::chrono::milliseconds(1));}
    return true;
  }
  nlohmann::json Status() const {std::lock_guard guard(mutex_);return {{"producer_id",producer_},{"next_offset",std::to_string(next_.load())},{"staged",staged_.load()},{"pending_upper_bound",usage_records_},{"bytes_upper_bound",usage_bytes_},{"full_rejections",full_rejections_},{"queued",inflight_records_.load()},{"async_failures",async_failures_.load()}};}
 private:
  static bool IsRecord(const std::filesystem::path& path){const auto name=path.filename().string();return name.size()==25&&name.substr(20)==".json"&&name.find_first_not_of("0123456789")>=20;}
  // Writer-thread only (single FIFO worker). Same on-disk sequence as the old synchronous path.
  void WriteRecord(nlohmann::json& value){
    try{
      if(before_write_)before_write_();
      std::lock_guard io(io_mutex_);
      const auto offset=next_.load();
      if(offset==std::numeric_limits<uint64_t>::max())throw std::runtime_error("Observation offset exhausted");
      value["offset"]=std::to_string(offset);
      const auto data=value.dump();if(data.size()>1024*1024)throw std::runtime_error("Observation record capacity exceeded");
      next_.store(offset+1);
      {const auto t0=std::chrono::steady_clock::now();SaveState(); // Only accepted records reserve an offset durably.
        JournalDiag().Note(true,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count());}
      std::ostringstream name;name<<std::setw(20)<<std::setfill('0')<<offset<<".json";
      {const auto t0=std::chrono::steady_clock::now();AtomicWrite(path_/name.str(),data);
        JournalDiag().Note(false,std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count());}
      ++staged_;
    }catch(...){++async_failures_;JournalDiag().async_failures.fetch_add(1,std::memory_order_relaxed);}
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
  std::atomic<uint64_t> next_{0},staged_{0},async_failures_{0};
  std::atomic<size_t> inflight_records_{0},inflight_bytes_{0};
  int lock_=-1;mutable std::mutex mutex_,io_mutex_;
  std::function<void()> before_write_; // test seam: gate the writer thread
  std::unique_ptr<output::ArchiveExecutor> writer_; // drained before the flock is released
};
}

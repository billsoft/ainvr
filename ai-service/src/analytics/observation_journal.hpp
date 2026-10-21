// AINVR. Ordered, private SSD journal of unified observations; no alarm logic.
#pragma once
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
#include <chrono>
namespace ai_service::analytics {
class ObservationJournal {
 public:
  static std::string Hash(const std::string& value) {
    unsigned char bytes[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(value.data()),value.size(),bytes);
    std::ostringstream out;for(auto b:bytes)out<<std::hex<<std::setw(2)<<std::setfill('0')<<int(b);return out.str();
  }
  ObservationJournal(const std::string& root,const std::string& channel,size_t max_bytes=64*1024*1024,size_t max_records=10000)
    :path_(std::filesystem::path(root)/Hash(channel)),channel_(channel),max_bytes_(max_bytes),max_records_(max_records) {
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
        if(used!=text.size()||text!=std::to_string(next_)||producer_.size()!=64)throw std::runtime_error("Invalid observation identity");
      }else{
        // Never invent a new producer identity over orphaned pending records.
        for(const auto& entry:std::filesystem::directory_iterator(path_))if(IsRecord(entry.path()))throw std::runtime_error("Observation identity missing");
        unsigned char seed[32];if(RAND_bytes(seed,sizeof(seed))!=1)throw std::runtime_error("Observation identity generation failed");
        producer_=Hash(std::string(reinterpret_cast<char*>(seed),sizeof(seed)));SaveState();
      }
    RefreshUsage();
    }catch(...){close(lock_);lock_=-1;throw;}
  }
  ~ObservationJournal(){if(lock_>=0)close(lock_);}
  ObservationJournal(const ObservationJournal&)=delete;
  ObservationJournal& operator=(const ObservationJournal&)=delete;
  void Stage(const FrameResult& result) {
    std::lock_guard guard(mutex_);
    if(result.channel_id!=channel_||result.frame_pts_ns<0||result.frame_index<0||!std::isfinite(result.timestamp))throw std::invalid_argument("Invalid observation source");
    const auto& analytics=result.model_extra.at("analytics");
    if(analytics.at("status")!="active")throw std::invalid_argument("Tracking result unavailable");
    if(next_==std::numeric_limits<uint64_t>::max())throw std::runtime_error("Observation offset exhausted");
    const auto offset=next_;
    nlohmann::json value={{"schema_version","1.0"},{"producer_id",producer_},{"offset",std::to_string(offset)},
      {"channel_id",channel_},{"stream_url",result.stream_url},{"stream_session_id",analytics.at("stream_session_id")},
      {"source_pts_ns",std::to_string(result.frame_pts_ns)},{"source_frame_index",std::to_string(result.frame_index)},
      {"timestamp",result.timestamp},{"width",result.frame_width},{"height",result.frame_height},
      {"model",{{"id",result.model_name},{"label_catalog",result.model_extra.at("label_catalog")}}},
      {"tracks",analytics.at("tracks")}};
    const auto data=value.dump();if(data.size()>1024*1024)throw std::runtime_error("Observation record capacity exceeded");
    // Only this locked producer can add files; the consumer can only delete.
    // Cached usage is therefore a conservative upper bound. Recount only when
    // near capacity, with bounded retries while the consumer is stopped.
    if(usage_records_>=max_records_||data.size()>max_bytes_-std::min(max_bytes_,usage_bytes_)){
      if(std::chrono::steady_clock::now()-usage_checked_>=std::chrono::seconds(1))RefreshUsage();
      if(usage_records_>=max_records_||data.size()>max_bytes_-std::min(max_bytes_,usage_bytes_)){
        ++full_rejections_;throw std::runtime_error("Observation journal full");
      }
    }
    ++next_;SaveState(); // Only accepted records reserve an offset durably.
    std::ostringstream name;name<<std::setw(20)<<std::setfill('0')<<offset<<".json";
    // Count before writing: even a rename followed by a failed directory fsync
    // may leave a record. An overestimate cannot exceed the storage bound.
    ++usage_records_;usage_bytes_+=data.size();
    AtomicWrite(path_/name.str(),data);++staged_;
  }
  nlohmann::json Status() const {std::lock_guard guard(mutex_);return {{"producer_id",producer_},{"next_offset",std::to_string(next_)},{"staged",staged_},{"pending_upper_bound",usage_records_},{"bytes_upper_bound",usage_bytes_},{"full_rejections",full_rejections_}};}
 private:
  static bool IsRecord(const std::filesystem::path& path){const auto name=path.filename().string();return name.size()==25&&name.substr(20)==".json"&&name.find_first_not_of("0123456789")>=20;}
  void RefreshUsage(){
    size_t bytes=0,count=0;
    for(const auto& entry:std::filesystem::directory_iterator(path_))if(IsRecord(entry.path())){
      std::error_code error;const auto size=entry.file_size(error);
      if(!error){bytes+=size;++count;}
      else if(error!=std::errc::no_such_file_or_directory)throw std::runtime_error("Observation journal scan failed");
    }
    usage_bytes_=bytes;usage_records_=count;usage_checked_=std::chrono::steady_clock::now();
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
    if(!ok||closed)throw std::runtime_error("Journal write not durable");
    std::filesystem::rename(temp,target);SyncDirectory();
  }
  void SaveState(){AtomicWrite(path_/"producer.json",nlohmann::json({{"schema_version","1.0"},{"channel_id",channel_},{"producer_id",producer_},{"next_offset",std::to_string(next_)}}).dump());}
  std::filesystem::path path_;std::string channel_,producer_;size_t max_bytes_,max_records_;
  size_t usage_bytes_=0,usage_records_=0;uint64_t full_rejections_=0;
  std::chrono::steady_clock::time_point usage_checked_;
  uint64_t next_=0,staged_=0;int lock_=-1;mutable std::mutex mutex_;
};
}

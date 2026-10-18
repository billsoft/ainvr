// Copyright AINVR. Optional SSD storage for unchanged compressed video bytes.
#pragma once
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

namespace ai_service::stream {
class AuSpoolError : public std::runtime_error {
 public: using std::runtime_error::runtime_error;
};
struct AuSpoolState {
  std::atomic<int64_t> bytes{0}, segments{0};
};
struct AuSpoolSegment {
  int fd;
  int64_t bytes=0;
  std::shared_ptr<AuSpoolState> state;
  AuSpoolSegment(int value,std::shared_ptr<AuSpoolState> counters)
      :fd(value),state(std::move(counters)){++state->segments;}
  ~AuSpoolSegment(){::close(fd);state->bytes-=bytes;--state->segments;}
  AuSpoolSegment(const AuSpoolSegment&)=delete;
};
class AuSpoolPayload {
 public:
  AuSpoolPayload(std::shared_ptr<AuSpoolSegment> segment,int64_t offset,size_t size)
      :segment_(std::move(segment)),offset_(offset),size_(size){}
  size_t Size()const{return size_;}
  std::vector<uint8_t> Read()const {
    std::vector<uint8_t> bytes(size_);size_t done=0;
    while(done<size_){
      const auto count=::pread(segment_->fd,bytes.data()+done,size_-done,offset_+done);
      if(count<0&&errno==EINTR)continue;
      if(count<=0)throw AuSpoolError("Cannot read retained compressed video bytes");
      done+=static_cast<size_t>(count);
    }
    return bytes;
  }
 private:
  std::shared_ptr<AuSpoolSegment> segment_;
  int64_t offset_;
  size_t size_;
};
class AuSpool {
 public:
  static constexpr int64_t kSegmentBytes=16*1024*1024;
  static constexpr int64_t kMaximumPacketBytes=64*1024*1024;
  static constexpr int64_t kMinimumFreeBytes=int64_t(8)*1024*1024*1024;
  explicit AuSpool(const std::string& directory,int64_t maximum_bytes):maximum_bytes_(maximum_bytes) {
    if(maximum_bytes<=0||maximum_bytes>int64_t(32)*1024*1024*1024)
      throw AuSpoolError("Invalid compressed video SSD budget");
    const auto ssd=std::filesystem::canonical("/mnt/ainvr-ssd");
    const auto path=std::filesystem::path(directory).lexically_normal();
    const auto parent=std::filesystem::canonical(path.parent_path());
    const auto relative=parent.lexically_relative(ssd);
    if(!path.is_absolute()||relative.empty()||*relative.begin()=="..")
      throw AuSpoolError("Compressed video cache must stay on the declared SSD");
    if(::mkdir(path.c_str(),0700)&&errno!=EEXIST)throw AuSpoolError("Cannot create private compressed video cache");
    directory_fd_=::open(path.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if(directory_fd_<0)throw AuSpoolError("Cannot open private compressed video cache");
    struct stat info{},ssd_info{};
    if(::fstat(directory_fd_,&info)||::stat(ssd.c_str(),&ssd_info)||info.st_dev!=ssd_info.st_dev||
       info.st_uid!=::getuid()||(info.st_mode&0077)){
      ::close(directory_fd_);directory_fd_=-1;
      throw AuSpoolError("Compressed video cache ownership/device/permissions differ");
    }
  }
  ~AuSpool(){current_.reset();if(directory_fd_>=0)::close(directory_fd_);}
  AuSpool(const AuSpool&)=delete;
  std::shared_ptr<AuSpoolPayload> Store(const std::vector<uint8_t>& bytes){
    std::lock_guard<std::mutex> lock(mutex_);
    if(bytes.empty()||bytes.size()>kMaximumPacketBytes)
      throw AuSpoolError("Compressed video packet exceeds SSD storage bounds");
    if(!current_||current_->bytes+static_cast<int64_t>(bytes.size())>kSegmentBytes){
      current_.reset();
      // Anonymous ext4 files have no persistent names. Kernel close/crash
      // cleanup releases them;there is no stale-video directory sweep.
      const int fd=::openat(directory_fd_,".",O_TMPFILE|O_RDWR|O_CLOEXEC,0600);
      if(fd<0)throw AuSpoolError("SSD does not support private anonymous video files");
      current_=std::make_shared<AuSpoolSegment>(fd,state_);
    }
    if(state_->bytes.load()+static_cast<int64_t>(bytes.size())>maximum_bytes_)
      throw AuSpoolError("Compressed video SSD budget exhausted");
    struct statvfs available{};
    if(::fstatvfs(directory_fd_,&available)||
       static_cast<uint64_t>(available.f_bavail)*available.f_frsize<kMinimumFreeBytes+bytes.size())
      throw AuSpoolError("SSD recording reserve would be exceeded");
    const auto offset=current_->bytes;size_t done=0;
    while(done<bytes.size()){
      const auto count=::pwrite(current_->fd,bytes.data()+done,bytes.size()-done,offset+done);
      if(count<0&&errno==EINTR)continue;
      if(count<=0)throw AuSpoolError("Cannot retain compressed video on SSD");
      done+=static_cast<size_t>(count);current_->bytes+=count;state_->bytes+=count;
    }
    return std::make_shared<AuSpoolPayload>(current_,offset,bytes.size());
  }
  void Reset(){std::lock_guard<std::mutex> lock(mutex_);current_.reset();}
  int64_t AllocatedBytes()const{return state_->bytes.load();}
  int64_t Segments()const{return state_->segments.load();}
 private:
  int directory_fd_=-1;
  int64_t maximum_bytes_;
  std::shared_ptr<AuSpoolState> state_=std::make_shared<AuSpoolState>();
  std::shared_ptr<AuSpoolSegment> current_;
  std::mutex mutex_;
};
}  // namespace ai_service::stream

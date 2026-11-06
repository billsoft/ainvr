#pragma once
#include <array>
#include <atomic>
#include <cerrno>
#include <ctime>
#include <cstdint>
#include <map>
#include <mutex>
#include <memory>
#include <stdexcept>
#include <string>
#include <tuple>
#include <sys/stat.h>
#include <unistd.h>
#include <openssl/evp.h>

namespace ainvr {
// Process-local, bounded cache. Always identify the open descriptor, never a
// pathname. Model deployment must replace files atomically, not mutate in place.
class ModelDigestCache {
 public:
  using Identity=std::tuple<dev_t,ino_t,off_t,time_t,long,time_t,long>;
  static Identity Identify(int fd){
    struct stat s{};
    if(fstat(fd,&s)||!S_ISREG(s.st_mode))throw std::runtime_error("Invalid HBM file");
    return {s.st_dev,s.st_ino,s.st_size,s.st_mtim.tv_sec,s.st_mtim.tv_nsec,s.st_ctim.tv_sec,s.st_ctim.tv_nsec};
  }
  std::string Get(int fd){
    // Coalesce concurrent cold requests, bound disk work and cache allocation.
    // This lock is independent of configuration, model SDK and status locks.
    std::lock_guard lock(mutex_);
    const auto identity=Identify(fd);
    // Linux/filesystem timestamp granularity can collapse adjacent writes.
    // Do not trust a metadata hit in the current/recent ctime window (or future).
    const auto now=std::time(nullptr),changed=std::get<5>(identity);
    const bool stable=now>changed && now-changed>=2;
    if(auto it=cache_.find(identity);stable&&it!=cache_.end()){
      if(Identify(fd)!=identity)throw std::runtime_error("HBM changed during acquisition");
      ++hits_;it->second.used=++sequence_;return it->second.hash;
    }
    ++misses_;
    std::unique_ptr<EVP_MD_CTX,decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(),EVP_MD_CTX_free);
    if(!ctx||EVP_DigestInit_ex(ctx.get(),EVP_sha256(),nullptr)!=1)throw std::runtime_error("HBM digest initialization failed");
    std::array<unsigned char,65536> buffer{};off_t offset=0;
    for(;;){
      auto n=pread(fd,buffer.data(),buffer.size(),offset);
      if(n<0&&errno==EINTR)continue;
      if(n<0)throw std::runtime_error("Cannot read HBM");
      if(!n)break;
      offset+=n;bytes_.fetch_add(n);
      if(EVP_DigestUpdate(ctx.get(),buffer.data(),n)!=1)throw std::runtime_error("HBM digest failed");
    }
    if(Identify(fd)!=identity)throw std::runtime_error("HBM changed during acquisition");
    unsigned char bytes[EVP_MAX_MD_SIZE];unsigned int size=0;
    if(EVP_DigestFinal_ex(ctx.get(),bytes,&size)!=1)throw std::runtime_error("HBM digest failed");
    std::string hash;const char* hex="0123456789abcdef";
    for(unsigned i=0;i<size;++i){hash+=hex[bytes[i]>>4];hash+=hex[bytes[i]&15];}
    if(cache_.size()>=128&&!cache_.count(identity)){
      auto oldest=cache_.begin();for(auto i=cache_.begin();i!=cache_.end();++i)if(i->second.used<oldest->second.used)oldest=i;
      cache_.erase(oldest);
    }
    cache_.insert_or_assign(identity,Entry{hash,++sequence_});return hash;
  }
  struct Stats {uint64_t hits,misses,bytes;};
  Stats Status()const{return {hits_.load(),misses_.load(),bytes_.load()};}
 private:
  struct Entry{std::string hash;uint64_t used;};
  std::mutex mutex_;std::map<Identity,Entry> cache_;uint64_t sequence_=0;
  std::atomic<uint64_t> hits_{0},misses_{0},bytes_{0};
};
}

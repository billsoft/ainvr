// Copyright AINVR. Never associate a repeated POC with an older dropped frame.
#pragma once
#include <algorithm>
#include <cstdint>
#include <deque>
#include <stdexcept>
#include <optional>
#include <vector>
namespace ainvr {
class PictureTokens {
 public:
  bool Contains(int poc) const {
    return std::any_of(pending_.begin(),pending_.end(),[&](const Entry& e){return e.poc==poc;});
  }
  void Push(int poc,uint64_t token){
    if(pending_.size()>=128)throw std::runtime_error("Too many unmatched decoded pictures");
    // POC repeats at GOP reset/wrap. An older unreturned occurrence makes the
    // hardware's POC-only display metadata ambiguous; fail before stamping SEI.
    if(Contains(poc))
      throw std::runtime_error("Ambiguous repeated display POC; recreate decoder before resuming");
    pending_.push_back({poc,token});
  }
  uint64_t Take(int poc){
    auto it=std::find_if(pending_.begin(),pending_.end(),[&](const Entry& e){return e.poc==poc;});
    if(it==pending_.end())throw std::runtime_error("Unmatched display POC; recreate decoder before resuming");
    const auto token=it->token;pending_.erase(it);return token;
  }
 private:
  struct Entry{int poc;uint64_t token;};
  std::deque<Entry> pending_;
};

// Parse a compressed picture once even when VPU input/POC admission must wait.
// Retain only one bounded access unit. A retry cannot change its identity/bytes.
class PreparedPicture {
 public:
  template<class Parse>
  int Prepare(const std::vector<uint8_t>& bytes,uint64_t token,size_t padding,Parse parse) {
    if(poc_) {
      if(token!=token_||bytes.size()!=size_||!std::equal(bytes.begin(),bytes.end(),bytes_.begin()))
        throw std::runtime_error("Pending picture changed before submission");
      return *poc_;
    }
    bytes_=bytes;size_=bytes.size();token_=token;
    bytes_.resize(size_+padding,0);
    poc_=parse(bytes_.data(),size_);
    return *poc_;
  }
  bool Pending() const {return poc_.has_value();}
  void Commit(){poc_.reset();bytes_.clear();}
 private:
  std::optional<int> poc_;
  uint64_t token_=0;size_t size_=0;
  std::vector<uint8_t> bytes_;
};
}

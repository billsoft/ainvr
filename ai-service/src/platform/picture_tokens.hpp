// Copyright AINVR. Never associate a repeated POC with an older dropped frame.
#pragma once
#include <algorithm>
#include <cstdint>
#include <deque>
#include <stdexcept>
namespace ainvr {
class PictureTokens {
 public:
  void Push(int poc,uint64_t token){
    if(pending_.size()>=128)throw std::runtime_error("Too many unmatched decoded pictures");
    // POC repeats at GOP reset/wrap. An older unreturned occurrence makes the
    // hardware's POC-only display metadata ambiguous; fail before stamping SEI.
    if(std::any_of(pending_.begin(),pending_.end(),[&](const Entry& e){return e.poc==poc;}))
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
}

// Copyright AINVR.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>
namespace ainvr {
// Private single-owner directory. Stage success means file and directory fsync
// completed. Caller must retain rejected/unconfirmed records and backpressure.
class ArchiveSpool {
 public:
  ArchiveSpool(const std::string& directory,size_t max_bytes,size_t max_records);
  ~ArchiveSpool();
  ArchiveSpool(const ArchiveSpool&)=delete;
  ArchiveSpool& operator=(const ArchiveSpool&)=delete;
  void Stage(const std::string& id,const std::vector<uint8_t>& bson);
  std::vector<std::string> Pending();
  // Callback must return only after acknowledged durable delivery. Throwing
  // preserves pending data. A crash after delivery can replay the same ID.
  void Deliver(const std::string& id,const std::function<void(const std::vector<uint8_t>&)>& write);
 private:
  struct State;std::unique_ptr<State> state_;
};
}  // namespace ainvr

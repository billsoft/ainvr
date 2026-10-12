// Copyright AINVR.
#pragma once
#include "archive_mongo.hpp"
#include "archive_spool.hpp"
#include "history_deletions.hpp"
#include <bson/bson.h>
#include <cmath>
namespace ainvr {
// Bounded synchronous replay of fully prepared records. The caller retains
// control of retry/backoff and shutdown. Exceptions stop at the failed record;
// the spool retains that record and every later record for the next attempt.
// Channel deletion/retention policy must be applied before invoking replay.
inline size_t ReplayPreparedArchive(ArchiveSpool& spool,ArchiveMongo& mongo,size_t limit){
  size_t delivered=0;
  for(const auto& id:spool.Pending()){
    if(delivered==limit)break;
    spool.Deliver(id,[&](const auto& bytes){mongo.Put(bytes);});
    ++delivered;
  }
  return delivered;
}
struct ArchiveReplayResult {size_t committed=0,deleted=0;};
// One channel owner serializes this operation with journal Add and new capture
// acceptance. Persist intent, acknowledge Mongo deletion, then retire or replay
// pending entries. Callback completion also represents a durable cancellation.
inline ArchiveReplayResult ReplayPreparedArchiveWithDeletions(ArchiveSpool& spool,ArchiveMongo& mongo,
    ai_service::output::HistoryDeletions& journal,size_t limit){
  journal.Flush();mongo.ApplyDeletionRules(journal.Rules().dump());ArchiveReplayResult result;
  for(const auto& id:spool.Pending()){
    if(result.committed+result.deleted==limit)break;
    bool deleted=false;
    spool.Deliver(id,[&](const auto& bytes){
      bson_t doc;bson_iter_t epoch,time;
      if(!bson_init_static(&doc,bytes.data(),bytes.size())||!bson_iter_init_find(&time,&doc,"timestamp")||!BSON_ITER_HOLDS_NUMBER(&time))throw std::runtime_error("Invalid replay timestamp");
      double timestamp=bson_iter_as_double(&time);uint64_t generation=0;
      if(!std::isfinite(timestamp))throw std::runtime_error("Nonfinite replay timestamp");
      if(bson_iter_init_find(&epoch,&doc,"archive_epoch")){
        if((!BSON_ITER_HOLDS_INT64(&epoch)&&!BSON_ITER_HOLDS_INT32(&epoch))||bson_iter_as_int64(&epoch)<0)throw std::runtime_error("Invalid replay epoch");
        generation=bson_iter_as_int64(&epoch);
      }
      deleted=journal.Matches(generation,id,timestamp);
      if(!deleted)mongo.Put(bytes);
    });
    if(deleted)++result.deleted;else ++result.committed;
  }
  return result;
}
}  // namespace ainvr

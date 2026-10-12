// Copyright AINVR. Native worker bridge with durable pre-encoding recovery.
// Production enablement still requires retention, deletion coordination and history API.
#pragma once
#include "prepared_snapshot_sink.hpp"
#include "raw_snapshot_task.hpp"
namespace ainvr {
class DurableSnapshotSink final:public FrameArchiveSink {
 public:
 DurableSnapshotSink(ai_service::config::SnapshotConfig config,std::string name,uint64_t epoch,
  RawFrameSpool& raw,ArchiveSpool& prepared,ArchiveMongo& mongo,SnapshotSinkStats& stats,
  ai_service::output::HistoryDeletions* deletions=nullptr)
  :config_(std::move(config)),name_(std::move(name)),epoch_(epoch),raw_(raw),prepared_(prepared),mongo_(mongo),stats_(stats),deletions_(deletions){
  Recover();
 }
 void Stage(Nv12Frame frame,FrameContext context,ai_service::FrameResult result,
  ai_service::output::ArchiveAdmission::Ticket ticket) override {
  // Retain admission ownership until raw input and all derived records are durable.
  if(deletions_)deletions_->Flush();
  auto task=MakeRawSnapshotTask(std::move(frame),result,config_,name_,deletions_?deletions_->Epoch():epoch_,context.bt709,context.full_range);
  raw_.Stage(NewArchiveId(),task);
  Recover();++stats_.frames;
 }
 private:
 void Recover(){
  PrepareRawSnapshots(raw_,prepared_,renderer_,[&](const auto& id){stats_.ids.push_back(id);++stats_.records;},deletions_);
  // Never drain prepared records until raw preparation completed. This prevents
  // a partial-frame retry from regenerating an already-delivered JPEG.
  try{
   if(deletions_)ReplayPreparedArchiveWithDeletions(prepared_,mongo_,*deletions_,64);
   else ReplayPreparedArchive(prepared_,mongo_,64);
   mongo_.TrimHistory(config_.max_count);
  }catch(const std::runtime_error&){++stats_.delivery_failures;}
 }
 ai_service::config::SnapshotConfig config_;std::string name_;uint64_t epoch_;
 RawFrameSpool& raw_;ArchiveSpool& prepared_;ArchiveMongo& mongo_;SnapshotSinkStats& stats_;
 SnapshotRenderer renderer_;
 // Channel owner must serialize journal mutations with Stage and construction.
 ai_service::output::HistoryDeletions* deletions_;
};
}

// Copyright AINVR. One serialized archive owner per channel, shared by API and worker.
#pragma once
#include "durable_snapshot_sink.hpp"
#include <sys/stat.h>
namespace ainvr {
class ChannelArchive:public std::enable_shared_from_this<ChannelArchive> {
 public:
 ChannelArchive(const std::filesystem::path& directory,const std::string& uri,
  const std::string& database,const std::string& channel_id)
  :directory_(PrivateDirectory(directory)),mongo_(uri,database,"snapshots_"+channel_id),
   raw_((directory_/"raw").string(),256*1024*1024),prepared_((directory_/"prepared").string(),256*1024*1024,10000){
  deletions_.Load(directory_.string());
 }
 static void Validate(const ai_service::config::SnapshotConfig& config){
  if(!config.enabled||config.min_interval_ms!=0||config.brightness_enabled||config.face_enhance_model!="none")
   throw std::invalid_argument("Native archive currently supports every-frame original snapshots");
  if(config.max_count<=0)throw std::invalid_argument("Archive retention must be positive");
 }
 std::unique_ptr<FrameArchiveSink> MakeSink(ai_service::config::SnapshotConfig config,std::string name){
  Validate(config);return std::make_unique<Sink>(shared_from_this(),std::move(config),std::move(name));
 }
 ArchiveMongo& Mongo(){return mongo_;}
 int64_t Delete(const nlohmann::json& filter){
  std::lock_guard lock(history_);deletions_.Flush();
  mongo_.ApplyDeletionRules(deletions_.Rules().dump());
  deletions_.Add(filter);
  return mongo_.ApplyDeletionRules(deletions_.Rules().dump());
 }
 nlohmann::json Stats(){std::lock_guard lock(history_);return {{"frames",stats_.frames.load()},
  {"records",stats_.records.load()},{"delivery_failures",stats_.delivery_failures.load()},
  {"raw_pending",raw_.Pending().size()},{"prepared_pending",prepared_.Pending().size()},{"archive_epoch",deletions_.Epoch()}};}
 private:
 static std::filesystem::path PrivateDirectory(const std::filesystem::path& path){
  std::filesystem::create_directories(path);
  auto status=std::filesystem::symlink_status(path);
  if(!std::filesystem::is_directory(status)||std::filesystem::is_symlink(status)||chmod(path.c_str(),0700)!=0)
   throw std::runtime_error("Archive directory unavailable");
  return path;
 }
 void ClearDetails(){stats_.ids.clear();stats_.render_backends.clear();stats_.encoder_backends.clear();}
 class Sink final:public FrameArchiveSink {
  public:
  Sink(std::shared_ptr<ChannelArchive> owner,ai_service::config::SnapshotConfig config,std::string name):owner_(std::move(owner)){
   std::lock_guard lock(owner_->history_);
   sink_=std::make_unique<DurableSnapshotSink>(std::move(config),std::move(name),owner_->deletions_.Epoch(),
    owner_->raw_,owner_->prepared_,owner_->mongo_,owner_->stats_,&owner_->deletions_);
   owner_->ClearDetails();
  }
  void Stage(Nv12Frame frame,FrameContext context,ai_service::FrameResult result,
   ai_service::output::ArchiveAdmission::Ticket ticket) override{
   std::lock_guard lock(owner_->history_);
   try{sink_->Stage(std::move(frame),std::move(context),std::move(result),std::move(ticket));}
   catch(...){owner_->ClearDetails();throw;}
   owner_->ClearDetails();
  }
  private:
  std::shared_ptr<ChannelArchive> owner_;std::unique_ptr<DurableSnapshotSink> sink_;
 };
 std::filesystem::path directory_;ArchiveMongo mongo_;RawFrameSpool raw_;ArchiveSpool prepared_;
 ai_service::output::HistoryDeletions deletions_;SnapshotSinkStats stats_;std::mutex history_;
};
}

// Copyright AINVR. Prepared-JPEG archival bridge for the native worker.
// Production enablement additionally requires pre-encoding recovery, retention,
// deletion coordination and the history API. Do not advertise those here.
#pragma once
#include "pipeline/channel_worker.hpp"
#include "snapshot_renderer.hpp"
#include "archive_document.hpp"
#include "archive_delivery.hpp"
#include <atomic>
namespace ainvr {
struct SnapshotSinkStats {
 std::atomic<uint64_t> frames{0},records{0},invalid_crops{0},delivery_failures{0};
 // Read only after the worker has stopped and joined.
 std::vector<std::string> ids,render_backends,encoder_backends;
};
class PreparedSnapshotSink final:public FrameArchiveSink {
 public:
 PreparedSnapshotSink(ai_service::config::SnapshotConfig config,std::string channel_name,
     uint64_t epoch,ArchiveSpool& spool,ArchiveMongo& mongo,SnapshotSinkStats& stats)
   :config_(std::move(config)),name_(std::move(channel_name)),epoch_(epoch),
    spool_(spool),mongo_(mongo),stats_(stats) {
  if(!config_.enabled||config_.min_interval_ms!=0||config_.brightness_enabled||
     config_.face_enhance_model!="none")
    throw std::invalid_argument("Prepared sink requires every-frame original screenshots");
 }
 void Stage(Nv12Frame frame,FrameContext context,ai_service::FrameResult result,
     ai_service::output::ArchiveAdmission::Ticket ticket) override {
  // Keep the ticket until all prepared records have been fsynced. Failure
  // propagates to the channel; it must not report an unaccepted frame complete.
  for(size_t i=0;i<result.detections.size();++i){
   auto image=renderer_.RenderOriginal(frame,result.detections[i].bbox,config_,
       result.task_type=="face_detection",context.bt709,context.full_range);
   if(!image){++stats_.invalid_crops;continue;}
   bson_oid_t oid;bson_oid_init(&oid,nullptr);char hex[25];bson_oid_to_string(&oid,hex);
   ArchiveDocumentInput input;input.image_id=hex;input.channel_name=name_;
   input.archive_epoch=epoch_;input.frame=result;input.detection_index=i;
   input.image={image->plan.width,image->plan.height,std::move(image->jpeg)};
   input.original_image=input.image;
   auto bytes=BuildArchiveDocument(input);spool_.Stage(input.image_id,bytes);
   stats_.ids.push_back(input.image_id);stats_.render_backends.push_back(image->render_backend);
   stats_.encoder_backends.push_back(image->encoder_backend);++stats_.records;
  }
  ++stats_.frames;
  // Mongo failures leave acknowledged prepared records in the durable spool.
  // Subsequent calls retry by immutable ObjectId; no duplicate rows are created.
  try{ReplayPreparedArchive(spool_,mongo_,64);}catch(const std::runtime_error&){++stats_.delivery_failures;}
 }
 private:
 ai_service::config::SnapshotConfig config_;std::string name_;uint64_t epoch_;
 ArchiveSpool& spool_;ArchiveMongo& mongo_;SnapshotSinkStats& stats_;SnapshotRenderer renderer_;
};
}

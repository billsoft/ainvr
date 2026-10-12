// Copyright AINVR. Durable snapshot input; IDs and config belong to the accepted frame.
#pragma once
#include "raw_frame_spool.hpp"
#include "archive_result_codec.hpp"
#include "archive_spool.hpp"
#include "archive_document.hpp"
#include "snapshot_renderer.hpp"
#include "history_deletions.hpp"
#include <bson/bson.h>
#include <set>
namespace ainvr {
inline std::string NewArchiveId(){bson_oid_t oid;bson_oid_init(&oid,nullptr);char hex[25];bson_oid_to_string(&oid,hex);return hex;}
inline RawFrameTask MakeRawSnapshotTask(Nv12Frame frame,const ai_service::FrameResult& result,
 const ai_service::config::SnapshotConfig& config,const std::string& channel_name,
 uint64_t epoch,bool bt709,bool full_range){
 if(!config.enabled||config.min_interval_ms!=0||config.brightness_enabled||config.face_enhance_model!="none")
  throw std::invalid_argument("Raw snapshot task requires every-frame original crops");
 if(frame.width!=result.frame_width||frame.height!=result.frame_height)
  throw std::invalid_argument("Raw snapshot result geometry mismatch");
 nlohmann::json cfg=nlohmann::json::object();
 cfg["enabled"]=config.enabled;
 cfg["max_count"]=config.max_count;
 cfg["min_interval_ms"]=config.min_interval_ms;
 cfg["jpeg_quality"]=config.jpeg_quality;
 cfg["max_crop_dimension"]=config.max_crop_dimension;
 cfg["padding_ratio"]=config.padding_ratio;
 cfg["projection_mode"]=config.projection_mode;
 cfg["brightness_enabled"]=config.brightness_enabled;
 cfg["brightness_target"]=config.brightness_target;
 cfg["face_enhance_model"]=config.face_enhance_model;
 cfg["face_enhance_blend"]=config.face_enhance_blend;
 nlohmann::json ids=nlohmann::json::array();for(size_t i=0;i<result.detections.size();++i)ids.push_back(NewArchiveId());
 return {std::move(frame),{{"snapshot_task_version",1},{"result",EncodeArchiveResult(result)},
  {"config",cfg},{"channel_name",channel_name},{"archive_epoch",epoch},
  {"bt709",bt709},{"full_range",full_range},{"image_ids",ids}}};
}
// The owner must finish raw preparation before delivering prepared records to Mongo.
// Existing prepared IDs are preserved byte-for-byte across partial-frame retries.
inline size_t PrepareRawSnapshots(RawFrameSpool& raw,ArchiveSpool& prepared,
 SnapshotRenderer& renderer,const std::function<void(const std::string&)>& after_record={},
 ai_service::output::HistoryDeletions* deletions=nullptr){
 // The channel owner serializes acceptance, deletion and replay. Persist intent
 // before retiring any raw task; prepared records are filtered at delivery too.
 if(deletions)deletions->Flush();
 size_t records=0;auto pending=prepared.Pending();std::set<std::string> existing(pending.begin(),pending.end());
 for(const auto& task_id:raw.Pending())raw.Deliver(task_id,[&](const RawFrameTask& task){
  const auto& m=task.metadata;
  if(m.at("snapshot_task_version")!=1)throw std::runtime_error("Unknown raw snapshot task version");
  auto result=DecodeArchiveResult(m.at("result"));
  if(task.frame.width!=result.frame_width||task.frame.height!=result.frame_height)
   throw std::runtime_error("Raw snapshot result geometry mismatch");
  ai_service::config::SnapshotConfig config;const auto& cfg=m.at("config");
  cfg.at("enabled").get_to(config.enabled);
  cfg.at("max_count").get_to(config.max_count);
  cfg.at("min_interval_ms").get_to(config.min_interval_ms);
  cfg.at("jpeg_quality").get_to(config.jpeg_quality);
  cfg.at("max_crop_dimension").get_to(config.max_crop_dimension);
  cfg.at("padding_ratio").get_to(config.padding_ratio);
  cfg.at("projection_mode").get_to(config.projection_mode);
  cfg.at("brightness_enabled").get_to(config.brightness_enabled);
  cfg.at("brightness_target").get_to(config.brightness_target);
  cfg.at("face_enhance_model").get_to(config.face_enhance_model);
  cfg.at("face_enhance_blend").get_to(config.face_enhance_blend);
  if(!config.enabled||config.min_interval_ms!=0||config.brightness_enabled||config.face_enhance_model!="none")
   throw std::runtime_error("Unsupported raw snapshot processing configuration");
  auto ids=m.at("image_ids").get<std::vector<std::string>>();
  if(ids.size()!=result.detections.size()||std::set<std::string>(ids.begin(),ids.end()).size()!=ids.size())
   throw std::runtime_error("Invalid raw snapshot image IDs");
  for(const auto& id:ids)if(id.size()!=24||!bson_oid_is_valid(id.c_str(),id.size()))throw std::runtime_error("Invalid raw snapshot image ID");
  for(size_t i=0;i<ids.size();++i){
   if(deletions&&deletions->Matches(m.at("archive_epoch").get<uint64_t>(),ids[i],result.timestamp))continue;
   if(existing.count(ids[i]))continue;
   auto image=renderer.RenderOriginal(task.frame,result.detections[i].bbox,config,
    result.task_type=="face_detection",m.at("bt709").get<bool>(),m.at("full_range").get<bool>());
   if(!image)continue;
   ArchiveDocumentInput input;input.image_id=ids[i];input.channel_name=m.at("channel_name").get<std::string>();
   input.archive_epoch=m.at("archive_epoch").get<uint64_t>();input.frame=result;input.detection_index=i;
   input.image={image->plan.width,image->plan.height,std::move(image->jpeg)};input.original_image=input.image;
   prepared.Stage(ids[i],BuildArchiveDocument(input));existing.insert(ids[i]);++records;
   if(after_record)after_record(ids[i]);
  }
 });
 return records;
}
}

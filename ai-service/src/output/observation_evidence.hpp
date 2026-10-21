// AINVR. Exact observation-to-archive binding. No nearest-time image fallback.
#pragma once
#include "result.hpp"
#include <mongoc/mongoc.h>
#include <algorithm>
#include <stdexcept>
namespace ai_service::output {
inline int64_t EvidenceInteger(const std::string& text){
 if(text.empty()||text.size()>19||(text.size()>1&&text.front()=='0')||!std::all_of(text.begin(),text.end(),[](unsigned char c){return c>='0'&&c<='9';}))throw std::invalid_argument("Invalid evidence frame integer");
 try{return std::stoll(text);}catch(...){throw std::invalid_argument("Evidence frame integer overflow");}
}
inline void EvidenceIdentity(const std::string& text){
 if(text.empty()||text.size()>512||!bson_utf8_validate(text.data(),text.size(),false)||std::any_of(text.begin(),text.end(),[](unsigned char c){return c<32;}))throw std::invalid_argument("Invalid evidence identity");
}
struct ObservationEvidenceQuery {
 std::string session_id,pts_ns,frame_index,track_id;
 void Validate()const{EvidenceIdentity(session_id);EvidenceIdentity(track_id);EvidenceInteger(pts_ns);EvidenceInteger(frame_index);}
};
inline std::vector<Detection> BindObservationEvidence(const FrameResult& frame){
 auto detections=frame.detections;
 const auto analytics=frame.model_extra.find("analytics");
 if(analytics==frame.model_extra.end()||!analytics->is_object()||analytics->value("status",std::string())!="active"||
    !analytics->contains("stream_session_id")||!analytics->at("stream_session_id").is_string()||frame.frame_pts_ns<0||frame.frame_index<0)return detections;
 const auto session=analytics->at("stream_session_id").get<std::string>();EvidenceIdentity(session);
 for(auto& detection:detections)if(!detection.track_id.empty()){
  detection.model_extra["observation_source"]={{"schema_version","1.0"},{"stream_session_id",session},
    {"source_pts_ns",std::to_string(frame.frame_pts_ns)},{"source_frame_index",std::to_string(frame.frame_index)},
    {"frame_width",frame.frame_width},{"frame_height",frame.frame_height}};
 }
 return detections;
}
inline nlohmann::json FindObservationEvidence(mongoc_collection_t* collection,const std::string& channel,const ObservationEvidenceQuery& query){
 query.Validate();EvidenceIdentity(channel);
 bson_t filter,opts,projection;bson_init(&filter);bson_init(&opts);bson_init(&projection);
 BSON_APPEND_UTF8(&filter,"channel_id",channel.c_str());BSON_APPEND_UTF8(&filter,"track_id",query.track_id.c_str());
 BSON_APPEND_INT64(&filter,"frame_pts_ns",EvidenceInteger(query.pts_ns));
 BSON_APPEND_UTF8(&filter,"model_extra.observation_source.schema_version","1.0");
 BSON_APPEND_UTF8(&filter,"model_extra.observation_source.stream_session_id",query.session_id.c_str());
 BSON_APPEND_UTF8(&filter,"model_extra.observation_source.source_pts_ns",query.pts_ns.c_str());
 BSON_APPEND_UTF8(&filter,"model_extra.observation_source.source_frame_index",query.frame_index.c_str());
 bson_t imageType;BSON_APPEND_DOCUMENT_BEGIN(&filter,"image.data",&imageType);BSON_APPEND_UTF8(&imageType,"$type","binData");bson_append_document_end(&filter,&imageType);
 for(const auto* name:{"image_id","label_id","image.width","image.height","original_image.width","original_image.height","model_extra.observation_source.frame_width","model_extra.observation_source.frame_height"})BSON_APPEND_INT32(&projection,name,1);
 BSON_APPEND_DOCUMENT(&opts,"projection",&projection);BSON_APPEND_INT64(&opts,"limit",2);BSON_APPEND_INT32(&opts,"maxTimeMS",2000);
 auto* cursor=mongoc_collection_find_with_opts(collection,&filter,&opts,nullptr);
 const bson_t* document=nullptr;nlohmann::json result={{"schema_version","1.0"},{"state","unavailable"},{"reason","not_saved_or_expired"}};
 int count=0;
 while(mongoc_cursor_next(cursor,&document)){
  if(++count>1){result={{"schema_version","1.0"},{"state","unavailable"},{"reason","ambiguous_frame"}};break;}
  auto string=[&](const char* name){bson_iter_t it,field;if(bson_iter_init(&it,document)&&bson_iter_find_descendant(&it,name,&field)&&BSON_ITER_HOLDS_UTF8(&field))return std::string(bson_iter_utf8(&field,nullptr));return std::string();};
  auto integer=[&](const char* name)->int64_t{bson_iter_t it,field;if(bson_iter_init(&it,document)&&bson_iter_find_descendant(&it,name,&field)&&(BSON_ITER_HOLDS_INT32(&field)||BSON_ITER_HOLDS_INT64(&field)))return bson_iter_as_int64(&field);return 0;};
  const auto image=string("image_id");
  if(image.empty()||integer("image.width")<1||integer("image.height")<1){result["reason"]="invalid_archive_record";continue;}
  auto variants=nlohmann::json::array({"processed"});if(integer("original_image.width")>0&&integer("original_image.height")>0)variants.push_back("original");
  result={{"schema_version","1.0"},{"state","available"},{"evidence",{
    {"kind","target_crop"},{"image_id",image},{"channel_id",channel},{"track_id",query.track_id},
    {"stream_session_id",query.session_id},{"source_pts_ns",query.pts_ns},{"source_frame_index",query.frame_index},
    {"frame_width",integer("model_extra.observation_source.frame_width")},{"frame_height",integer("model_extra.observation_source.frame_height")},
    {"image_width",integer("image.width")},{"image_height",integer("image.height")},
    {"label_id",string("label_id")},{"variants",variants},{"pinned",false},{"retention","ai_history"}}}};
 }
 bson_error_t error{};const bool failed=mongoc_cursor_error(cursor,&error);
 mongoc_cursor_destroy(cursor);bson_destroy(&projection);bson_destroy(&opts);bson_destroy(&filter);
 if(failed)throw std::runtime_error("Evidence lookup unavailable");
 return result;
}
}

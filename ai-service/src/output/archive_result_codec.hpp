// Copyright AINVR. Internal lossless journal format; public ToDict stays unchanged.
#pragma once
#include "result.hpp"
#include <cmath>
#include <stdexcept>
namespace ainvr {
namespace archive_result_detail {
inline void ValidateNumbers(const nlohmann::json& value) {
 if(value.is_number_float() && !std::isfinite(value.get<double>()))
  throw std::invalid_argument("Non-finite archive result value");
 if(value.is_structured()) for(const auto& item:value) ValidateNumbers(item);
}
}
inline nlohmann::json EncodeArchiveResult(const ai_service::FrameResult& r) {
 nlohmann::json j={{"journal_result_version",1}};
 j["schema_version"]=r.schema_version;
 j["channel_id"]=r.channel_id;
 j["stream_url"]=r.stream_url;
 j["stream_protocol"]=r.stream_protocol;
 j["timestamp"]=r.timestamp;
 j["frame_pts_ns"]=r.frame_pts_ns;
 j["frame_index"]=r.frame_index;
 j["frame_width"]=r.frame_width;
 j["frame_height"]=r.frame_height;
 j["model_name"]=r.model_name;
 j["model_format"]=r.model_format;
 j["model_provider"]=r.model_provider;
 j["model_input_size"]=r.model_input_size;
 j["model_end2end"]=r.model_end2end;
 j["model_version"]=r.model_version;
 j["time_decode_ms"]=r.time_decode_ms;
 j["time_preprocess_ms"]=r.time_preprocess_ms;
 j["time_inference_ms"]=r.time_inference_ms;
 j["time_postprocess_ms"]=r.time_postprocess_ms;
 j["task_type"]=r.task_type;
 j["model_extra"]=r.model_extra;
 j["detections"]=nlohmann::json::array();
 for(const auto& d:r.detections){
  nlohmann::json v=nlohmann::json::object();
  v["class_id"]=d.class_id;
  v["class_name"]=d.class_name;
  v["confidence"]=d.confidence;
  v["bbox"]=d.bbox;
  v["confidence_known"]=d.confidence_known;
  v["label_id"]=d.label_id;
  v["query_description"]=d.query_description;
  v["model_extra"]=d.model_extra;
  v["landmarks"]=d.landmarks ? nlohmann::json(*d.landmarks) : nlohmann::json(nullptr);
  j["detections"].push_back(std::move(v));
 }
 archive_result_detail::ValidateNumbers(j);
 return j;
}
inline ai_service::FrameResult DecodeArchiveResult(const nlohmann::json& j) {
 if(j.at("journal_result_version")!=1) throw std::invalid_argument("Unsupported archive result version");
 archive_result_detail::ValidateNumbers(j);
 ai_service::FrameResult r;
 j.at("schema_version").get_to(r.schema_version);
 j.at("channel_id").get_to(r.channel_id);
 j.at("stream_url").get_to(r.stream_url);
 j.at("stream_protocol").get_to(r.stream_protocol);
 j.at("timestamp").get_to(r.timestamp);
 j.at("frame_pts_ns").get_to(r.frame_pts_ns);
 j.at("frame_index").get_to(r.frame_index);
 j.at("frame_width").get_to(r.frame_width);
 j.at("frame_height").get_to(r.frame_height);
 j.at("model_name").get_to(r.model_name);
 j.at("model_format").get_to(r.model_format);
 j.at("model_provider").get_to(r.model_provider);
 j.at("model_input_size").get_to(r.model_input_size);
 j.at("model_end2end").get_to(r.model_end2end);
 j.at("model_version").get_to(r.model_version);
 j.at("time_decode_ms").get_to(r.time_decode_ms);
 j.at("time_preprocess_ms").get_to(r.time_preprocess_ms);
 j.at("time_inference_ms").get_to(r.time_inference_ms);
 j.at("time_postprocess_ms").get_to(r.time_postprocess_ms);
 j.at("task_type").get_to(r.task_type);
 j.at("model_extra").get_to(r.model_extra);
 const auto& detections=j.at("detections");
 if(!detections.is_array()) throw std::invalid_argument("Invalid archive detections");
 for(const auto& v:detections){
  ai_service::Detection d;
  v.at("class_id").get_to(d.class_id);
  v.at("class_name").get_to(d.class_name);
  v.at("confidence").get_to(d.confidence);
  v.at("bbox").get_to(d.bbox);
  v.at("confidence_known").get_to(d.confidence_known);
  v.at("label_id").get_to(d.label_id);
  v.at("query_description").get_to(d.query_description);
  v.at("model_extra").get_to(d.model_extra);
  if(!v.at("landmarks").is_null())
   d.landmarks=v.at("landmarks").get<std::vector<std::array<double,2>>>();
  r.detections.push_back(std::move(d));
 }
 return r;
}
}

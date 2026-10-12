// Copyright AINVR. Reference-compatible list projection.
#pragma once
#include <nlohmann/json.hpp>
namespace ainvr {
using nlohmann::json;
inline json DocToListItem(const json& doc) {
  auto get = [&](const char* k) { return doc.contains(k) ? doc[k] : json(nullptr); };
  json image = doc.contains("image") && doc["image"].is_object() ? doc["image"] : json::object();
  json item{
      {"image_id", get("image_id")},
      {"channel_id", get("channel_id")},
      {"channel_name", get("channel_name")},
      {"frame_pts_ns", get("frame_pts_ns")},
      {"timestamp", get("timestamp")},
      {"model_name", get("model_name")},
      {"task_type", get("task_type")},
      {"class_id", get("class_id")},
      {"class_name", get("class_name")},
      {"confidence", get("confidence")},
      {"bbox", get("bbox")},
      {"landmarks", get("landmarks")},
      {"image_width", image.contains("width") ? image["width"] : json(nullptr)},
      {"image_height", image.contains("height") ? image["height"] : json(nullptr)},
      {"enhanced", doc.contains("enhanced") && doc["enhanced"].is_boolean() && doc["enhanced"].get<bool>()},
  };
  for (const auto* key : {"label_id", "query_description", "model_extra"})
    if (doc.contains(key)) item[key] = doc[key];
  return item;
}

}

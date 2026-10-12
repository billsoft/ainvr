// Copyright AINVR.
#include "archive_document.hpp"
#include <bson/bson.h>
#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
namespace ainvr {
namespace {
using Bson=std::unique_ptr<bson_t,decltype(&bson_destroy)>;
void Check(bool ok){if(!ok)throw std::runtime_error("Cannot construct archive BSON");}
void ValidateImage(const ArchiveImage& image){
  if(image.width<1||image.height<1||image.width>8192||image.height>8192||image.jpeg.size()<4||image.jpeg.size()>16*1024*1024||
     image.jpeg[0]!=0xff||image.jpeg[1]!=0xd8||image.jpeg[image.jpeg.size()-2]!=0xff||image.jpeg.back()!=0xd9)
    throw std::invalid_argument("Invalid archive JPEG envelope");
}
void AppendImage(bson_t* doc,const char* key,const ArchiveImage& image){
  Bson child(bson_new(),bson_destroy);if(!child)throw std::bad_alloc();
  Check(BSON_APPEND_UTF8(child.get(),"format","jpg"));
  Check(BSON_APPEND_INT32(child.get(),"width",image.width));Check(BSON_APPEND_INT32(child.get(),"height",image.height));
  Check(bson_append_binary(child.get(),"data",-1,BSON_SUBTYPE_BINARY,image.jpeg.data(),image.jpeg.size()));
  Check(BSON_APPEND_DOCUMENT(doc,key,child.get()));
}
}
std::vector<uint8_t> BuildArchiveDocument(const ArchiveDocumentInput& in){
  const auto& f=in.frame;
  if(in.image_id.size()!=24||!bson_oid_is_valid(in.image_id.c_str(),in.image_id.size())||
     in.archive_epoch>uint64_t(std::numeric_limits<int64_t>::max())||in.detection_index>=f.detections.size()||
     f.channel_id.empty()||!std::isfinite(f.timestamp)||f.timestamp<=0||(in.enhanced&&in.enhance_model.empty()))
    throw std::invalid_argument("Invalid archive identity or metadata");
  ValidateImage(in.image);ValidateImage(in.original_image);
  if(in.image.jpeg.size()+in.original_image.jpeg.size()>16*1024*1024)throw std::invalid_argument("Archive exceeds BSON size limit");
  const auto& d=f.detections[in.detection_index];
  if(!std::all_of(d.bbox.begin(),d.bbox.end(),[](double v){return std::isfinite(v);})||d.bbox[2]<=0||d.bbox[3]<=0||
     (d.confidence_known&&(!std::isfinite(d.confidence)||d.confidence<0||d.confidence>1)))throw std::invalid_argument("Invalid archive detection");
  nlohmann::json landmarks=nullptr;
  if(d.landmarks&&!d.landmarks->empty()){
    landmarks=nlohmann::json::array();
    for(auto p:*d.landmarks){if(!std::isfinite(p[0])||!std::isfinite(p[1]))throw std::invalid_argument("Invalid archive landmark");landmarks.push_back({{"x",p[0]},{"y",p[1]}});}
  }
  nlohmann::json metadata={{"image_id",in.image_id},{"channel_id",f.channel_id},{"channel_name",in.channel_name},
    {"timestamp",f.timestamp},{"model_name",f.model_name},{"task_type",f.task_type},{"class_id",d.class_id},{"class_name",d.class_name},
    {"confidence",d.confidence_known?nlohmann::json(d.confidence):nlohmann::json(nullptr)},
    {"bbox",{{"x",d.bbox[0]},{"y",d.bbox[1]},{"w",d.bbox[2]},{"h",d.bbox[3]}}},{"landmarks",landmarks},
    {"enhanced",in.enhanced},{"enhance_model",in.enhanced?nlohmann::json(in.enhance_model):nlohmann::json(nullptr)},
    {"brightness_corrected",in.brightness_corrected},{"embedding",nullptr},{"embedding_model",nullptr}};
  if(!d.label_id.empty())metadata["label_id"]=d.label_id;
  if(!d.query_description.empty())metadata["query_description"]=d.query_description;
  if(!d.model_extra.empty())metadata["model_extra"]=d.model_extra;
  auto text=metadata.dump();bson_error_t error{};
  Bson doc(bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error),bson_destroy);
  if(!doc)throw std::invalid_argument("Invalid archive BSON metadata");
  bson_oid_t oid;bson_oid_init_from_string(&oid,in.image_id.c_str());
  Check(BSON_APPEND_OID(doc.get(),"_id",&oid));Check(BSON_APPEND_INT64(doc.get(),"archive_epoch",in.archive_epoch));
  Check(BSON_APPEND_INT64(doc.get(),"frame_pts_ns",f.frame_pts_ns));
  AppendImage(doc.get(),"image",in.image);AppendImage(doc.get(),"original_image",in.original_image);
  if(doc->len>16*1024*1024)throw std::invalid_argument("Archive exceeds BSON size limit");
  const uint8_t* bytes=bson_get_data(doc.get());return {bytes,bytes+doc->len};
}
}  // namespace ainvr

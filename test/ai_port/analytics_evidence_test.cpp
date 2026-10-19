#include "../../ai-service/src/analytics/event_store.hpp"
#include <mongoc/mongoc.h>
#include <cassert>
#include <chrono>
#include <iostream>
int main() {
  std::string uri;std::getline(std::cin,uri);assert(!uri.empty());
  ai_service::analytics::EventStore store(uri,"ainvr_snapshots","test_analytics_events");
  const std::string channel="test-evidence-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  auto* client=mongoc_client_new(uri.c_str());assert(client);
  auto* collection=mongoc_client_get_collection(client,"ainvr_snapshots",("snapshots_"+channel).c_str());
  nlohmann::json event={{"event_id","event"},{"channel_id",channel},{"track_id","track"},{"stream_session_id","session"},{"frame_pts_ns","42"}};
  auto insert=[&](const char* image,int64_t pts) {
    const auto text=nlohmann::json({{"image_id",image},{"channel_id",channel},{"track_id","track"},{"frame_pts_ns",pts},
      {"model_extra",{{"analytics_event_ids",{"event"}},{"tracking_session_id","session"}}}}).dump();
    bson_t* doc=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),nullptr);assert(doc);
    bson_t original;BSON_APPEND_DOCUMENT_BEGIN(doc,"original_image",&original);
    BSON_APPEND_UTF8(&original,"format","jpg");BSON_APPEND_INT32(&original,"width",32);BSON_APPEND_INT32(&original,"height",16);
    // Envelope-only fixture, never submitted to a decoder or model.
    const uint8_t jpeg[]={0xff,0xd8,0xff,0xd9};
    bson_append_binary(&original,"data",-1,BSON_SUBTYPE_BINARY,jpeg,sizeof(jpeg));bson_append_document_end(doc,&original);
    bson_error_t error{};assert(mongoc_collection_insert_one(collection,doc,nullptr,nullptr,&error));bson_destroy(doc);
  };
  assert(!store.LoadEvidence(event));
  insert("wrong-frame",41);assert(!store.LoadEvidence(event));
  insert("exact-frame",42);
  const auto found=store.LoadEvidence(event);assert(found&&found->image_id=="exact-frame"&&found->width==32&&found->height==16&&found->jpeg.size()==4);
  for(const char* key:{"event_id","track_id","stream_session_id","channel_id"}) {
    auto mismatch=event;mismatch[key]="other";assert(!store.LoadEvidence(mismatch));
  }
  auto bad=event;bad["frame_pts_ns"]="42x";
  bool invalid=false;try{store.LoadEvidence(bad);}catch(const std::invalid_argument&){invalid=true;}assert(invalid);
  insert("duplicate",42);
  bool ambiguous=false;try{store.LoadEvidence(event);}catch(const std::runtime_error&){ambiguous=true;}assert(ambiguous);
  bson_error_t error{};assert(mongoc_collection_drop(collection,&error));
  mongoc_collection_destroy(collection);mongoc_client_destroy(client);
  std::cout<<"exact event evidence lookup: PASS (JPEG envelope fixture only)\n";
}

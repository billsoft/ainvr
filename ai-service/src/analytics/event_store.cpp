#include "event_store.hpp"
#include <mongoc/mongoc.h>
#include <mutex>
#include <stdexcept>
#include <cmath>
namespace ai_service::analytics {
namespace {
using Doc=std::unique_ptr<bson_t,decltype(&bson_destroy)>;
Doc BsonOrdered(const nlohmann::ordered_json& j) {
  auto text=j.dump();bson_error_t error{};
  auto* p=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error);
  if(!p) throw std::invalid_argument("Invalid analytics BSON");
  return Doc(p,bson_destroy);
}
Doc Bson(const nlohmann::json& j) { return BsonOrdered(nlohmann::ordered_json(j)); }
void Fail(const bson_error_t& e) {
  throw std::runtime_error("Analytics database error domain="+std::to_string(e.domain)+" code="+std::to_string(e.code));
}
void JobIdentity(const std::string& id,const std::string& stage) {
  if(id.empty()||id.size()>512||(stage!="review"&&stage!="notification"))
    throw std::invalid_argument("Invalid analytics job identity");
}
void LeaseIdentity(const std::string& token,double now) {
  if(token.empty()||token.size()>128||!std::isfinite(now)||now<0||now>1e12)
    throw std::invalid_argument("Invalid analytics job lease");
}
}
struct EventStore::State {
  mongoc_client_t* client=nullptr;
  mongoc_collection_t* collection=nullptr;
  std::mutex mutex;
  std::string database,collection_name;
  bool indexes_ready=false;
  ~State(){if(collection)mongoc_collection_destroy(collection);if(client)mongoc_client_destroy(client);}
};
EventStore::EventStore(const std::string& uri,const std::string& database,const std::string& collection)
  :state_(std::make_unique<State>()) {
  static std::once_flag once;std::call_once(once,[]{mongoc_init();});
  if(database.empty()||collection.empty())throw std::invalid_argument("Empty analytics namespace");
  bson_error_t error{};
  std::unique_ptr<mongoc_uri_t,decltype(&mongoc_uri_destroy)> parsed(
    mongoc_uri_new_with_error(uri.c_str(),&error),mongoc_uri_destroy);
  if(!parsed)throw std::invalid_argument("Invalid analytics database URI");
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_SERVERSELECTIONTIMEOUTMS,2000);
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_CONNECTTIMEOUTMS,2000);
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_SOCKETTIMEOUTMS,5000);
  state_->database=database;state_->collection_name=collection;
  state_->client=mongoc_client_new_from_uri(parsed.get());
  if(!state_->client)throw std::runtime_error("Analytics database client unavailable");
  state_->collection=mongoc_client_get_collection(state_->client,database.c_str(),collection.c_str());
}
EventStore::~EventStore()=default;
std::optional<EventStore::Evidence> EventStore::LoadEvidence(const nlohmann::json& event) {
  auto identity=[&](const char* key) {
    const auto value=event.at(key).get<std::string>();
    if(value.empty()||value.size()>512)throw std::invalid_argument("Invalid evidence identity");
    return value;
  };
  const auto channel=identity("channel_id"),id=identity("event_id"),track=identity("track_id"),session=identity("stream_session_id");
  const auto pts_text=identity("frame_pts_ns");
  if(pts_text.find_first_not_of("0123456789")!=std::string::npos)
    throw std::invalid_argument("Invalid evidence PTS");
  const auto pts=std::stoll(pts_text);
  auto filter=Bson({{"channel_id",channel},{"track_id",track},{"frame_pts_ns",pts},
    {"model_extra.analytics_event_ids",id},{"model_extra.tracking_session_id",session}});
  auto options=BsonOrdered({{"limit",2},{"projection",{{"image_id",1},{"original_image",1}}}});
  std::lock_guard lock(state_->mutex);
  std::unique_ptr<mongoc_collection_t,decltype(&mongoc_collection_destroy)> collection(
    mongoc_client_get_collection(state_->client,state_->database.c_str(),("snapshots_"+channel).c_str()),mongoc_collection_destroy);
  std::unique_ptr<mongoc_cursor_t,decltype(&mongoc_cursor_destroy)> cursor(
    mongoc_collection_find_with_opts(collection.get(),filter.get(),options.get(),nullptr),mongoc_cursor_destroy);
  const bson_t* doc=nullptr;std::optional<Evidence> found;
  while(mongoc_cursor_next(cursor.get(),&doc)) {
    if(found)throw std::runtime_error("Ambiguous event evidence");
    auto field=[&](const char* key) {
      bson_iter_t root,it;
      if(!bson_iter_init(&root,doc)||!bson_iter_find_descendant(&root,key,&it))
        throw std::runtime_error("Incomplete original event evidence");
      return it;
    };
    Evidence evidence;
    auto image_id=field("image_id"),format=field("original_image.format");
    if(!BSON_ITER_HOLDS_UTF8(&image_id)||!BSON_ITER_HOLDS_UTF8(&format)||
       std::string(bson_iter_utf8(&format,nullptr))!="jpg")throw std::runtime_error("Invalid evidence format");
    evidence.image_id=bson_iter_utf8(&image_id,nullptr);
    if(evidence.image_id.empty()||evidence.image_id.size()>128)throw std::runtime_error("Invalid evidence image ID");
    auto dimension=[&](const char* key) {
      auto it=field(key);
      if(!BSON_ITER_HOLDS_INT32(&it)&&!BSON_ITER_HOLDS_INT64(&it))throw std::runtime_error("Invalid evidence dimension");
      const auto value=bson_iter_as_int64(&it);
      if(value<1||value>8192)throw std::runtime_error("Invalid evidence dimension");
      return static_cast<int>(value);
    };
    evidence.width=dimension("original_image.width");evidence.height=dimension("original_image.height");
    auto bytes=field("original_image.data");
    if(!BSON_ITER_HOLDS_BINARY(&bytes))throw std::runtime_error("Missing evidence image bytes");
    bson_subtype_t type;uint32_t size;const uint8_t* data;
    bson_iter_binary(&bytes,&type,&size,&data);
    if(type!=BSON_SUBTYPE_BINARY||size<4||size>16U*1024*1024||data[0]!=0xff||data[1]!=0xd8||data[size-2]!=0xff||data[size-1]!=0xd9)
      throw std::runtime_error("Invalid evidence JPEG envelope");
    evidence.jpeg.assign(data,data+size);found=std::move(evidence);
  }
  bson_error_t error{};if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return found;
}
bool EventStore::UpdateJob(const nlohmann::json& filter,const nlohmann::json& update) {
  auto query=Bson(filter),change=Bson(update);
  auto options=Bson({{"writeConcern",{{"w",1},{"j",true},{"wtimeout",3000}}}});
  std::lock_guard lock(state_->mutex);
  bson_error_t error{};bson_t reply;
  const bool ok=mongoc_collection_update_one(state_->collection,query.get(),change.get(),options.get(),&reply,&error);
  if(!ok){bson_destroy(&reply);Fail(error);}
  bson_iter_t it;
  const bool matched=bson_iter_init_find(&it,&reply,"matchedCount")&&bson_iter_as_int64(&it)==1;
  bson_destroy(&reply);return matched;
}
void EventStore::AdvanceNotifications(const std::string& channel) {
  JobIdentity(channel,"notification");
  std::lock_guard lock(state_->mutex);
  auto transition=[&](nlohmann::json criteria,const std::string& status) {
    criteria["channel_id"]=channel;criteria["notification_request.enabled"]=true;
    criteria["notification_status"]={{"$in",nlohmann::json::array({"not_requested","waiting_review"})}};
    auto filter=Bson(criteria),change=Bson({{"$set",{{"notification_status",status}}}});
    auto options=Bson({{"writeConcern",{{"w",1},{"j",true},{"wtimeout",3000}}}});
    bson_error_t error{};bson_t reply;
    const bool ok=mongoc_collection_update_many(state_->collection,filter.get(),change.get(),options.get(),&reply,&error);
    bson_destroy(&reply);if(!ok)Fail(error);
  };
  transition({{"notification_request.require_review",true},{"review_status",{{"$in",nlohmann::json::array({"not_requested","pending","processing"})}}}},"waiting_review");
  transition({{"$or",nlohmann::json::array({
    {{"notification_request.require_review",false}},
    {{"notification_request.require_review",true},{"review_status","approved"}}
  })}},"pending");
  transition({{"notification_request.require_review",true},{"review_status",{{"$in",nlohmann::json::array({"rejected","failed","timeout","unavailable"})}}}},"suppressed");
}
bool EventStore::QueueJob(const std::string& id,const std::string& stage) {
  JobIdentity(id,stage);
  return UpdateJob({{"_id",id},{stage+"_status","not_requested"}},
                   {{"$set",{{stage+"_status","pending"}}}});
}
nlohmann::json EventStore::ReadyJobs(const std::string& channel,const std::string& stage,
                                    double now,int limit) {
  JobIdentity(channel,stage);LeaseIdentity("query",now);
  if(limit<1||limit>100)throw std::invalid_argument("Invalid job batch size");
  auto filter=Bson({{"channel_id",channel},{"$or",nlohmann::json::array({
    {{stage+"_status","pending"}},
    {{stage+"_status","processing"},{stage+"_job.expires_at",{{"$lte",now}}}}
  })}});
  auto options=BsonOrdered({{"limit",limit},{"sort",{{"timestamp",1},{"_id",1}}},
    {"projection",{{"review_job.token",0},{"notification_job.token",0}}}});
  std::lock_guard lock(state_->mutex);
  std::unique_ptr<mongoc_cursor_t,decltype(&mongoc_cursor_destroy)> cursor(
    mongoc_collection_find_with_opts(state_->collection,filter.get(),options.get(),nullptr),mongoc_cursor_destroy);
  auto result=nlohmann::json::array();const bson_t* doc=nullptr;
  while(mongoc_cursor_next(cursor.get(),&doc)) {
    char* text=bson_as_relaxed_extended_json(doc,nullptr);
    try {auto item=nlohmann::json::parse(text);item.erase("_id");result.push_back(std::move(item));}
    catch(...){bson_free(text);throw;}
    bson_free(text);
  }
  bson_error_t error{};if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return result;
}
bool EventStore::ClaimJob(const std::string& id,const std::string& stage,
                          const std::string& token,double now,double seconds) {
  JobIdentity(id,stage);LeaseIdentity(token,now);
  if(!std::isfinite(seconds)||seconds<=0||seconds>3600)
    throw std::invalid_argument("Invalid analytics job lease duration");
  const auto status=stage+"_status",job=stage+"_job";
  return UpdateJob({{"_id",id},{"$or",nlohmann::json::array({
    {{status,"pending"}},
    {{status,"processing"},{job+".expires_at",{{"$lte",now}}}}
  })}},{{"$set",{{status,"processing"},{job+".token",token},
                    {job+".started_at",now},{job+".expires_at",now+seconds}}},
         {"$inc",{{job+".attempts",1}}}});
}
bool EventStore::FinishJob(const std::string& id,const std::string& stage,
                           const std::string& token,double now,
                           const std::string& outcome,const nlohmann::json& result) {
  JobIdentity(id,stage);LeaseIdentity(token,now);
  const bool allowed=stage=="review"?
    (outcome=="approved"||outcome=="rejected"||outcome=="failed"||outcome=="timeout"||outcome=="unavailable"):
    (outcome=="sent"||outcome=="failed"||outcome=="timeout");
  if(!allowed||!result.is_object()||result.dump().size()>16384)
    throw std::invalid_argument("Invalid analytics job outcome");
  const auto status=stage+"_status",job=stage+"_job";
  // An expired attempt cannot commit, even before another worker takes over.
  return UpdateJob({{"_id",id},{status,"processing"},{job+".token",token},
                    {job+".expires_at",{{"$gt",now}}}},
    {{"$set",{{status,outcome},{job+".finished_at",now},{job+".result",result}}},
     {"$unset",{{job+".token",""},{job+".expires_at",""}}}});
}
void EventStore::Put(const nlohmann::json& event) {
  for(const char* key:{"event_id","channel_id","stream_session_id","rule_id","type","track_id"})
    if(!event.contains(key)||!event[key].is_string()||event[key].get<std::string>().empty()||
       event[key].get<std::string>().size()>512)throw std::invalid_argument("Missing analytics event identity");
  if(!event.contains("timestamp")||!event["timestamp"].is_number()||
     !std::isfinite(event["timestamp"].get<double>()))throw std::invalid_argument("Invalid event time");
  if(event.dump().size()>65536)throw std::invalid_argument("Event payload exceeds limit");
  auto filter=Bson({{"_id",event["event_id"]}});
  auto document=event;document.erase("_id");
  const int retention=event.value("retention_days",30);
  if(retention<1||retention>365)throw std::invalid_argument("Invalid event retention");
  const double expiry=(event["timestamp"].get<double>()+retention*86400.0)*1000;
  if(expiry<0||expiry>9e15)throw std::invalid_argument("Invalid expiry");
  document["expires_at"]={{"$date",{{"$numberLong",std::to_string(static_cast<int64_t>(expiry))}}}};
  auto update=Bson({{"$setOnInsert",document}});
  auto options=Bson({{"upsert",true},{"writeConcern",{{"w",1},{"j",true},{"wtimeout",3000}}}});
  std::lock_guard lock(state_->mutex);
  bson_error_t error{};bson_t reply;
  if(!state_->indexes_ready) {
    // Compound index order is semantic: ordinary json sorts keys alphabetically.
    // Keep the old index intact during rollout; the v2 name avoids a key conflict.
    auto command=BsonOrdered({{"createIndexes",state_->collection_name},{"indexes",nlohmann::ordered_json::array({
      {{"key",{{"expires_at",1}}},{"name","analytics_expiry"},{"expireAfterSeconds",0}},
      {{"key",{{"channel_id",1},{"timestamp",-1},{"_id",-1}}},{"name","analytics_channel_time_v2"}},
      {{"key",{{"channel_id",1},{"review_status",1},{"review_job.expires_at",1}}},{"name","analytics_review_ready_v1"}},
      {{"key",{{"channel_id",1},{"notification_status",1},{"notification_job.expires_at",1}}},{"name","analytics_notification_ready_v1"}}
    })}});
    bool indexed=mongoc_client_command_simple(state_->client,state_->database.c_str(),command.get(),nullptr,&reply,&error);
    bson_destroy(&reply);if(!indexed)Fail(error);
    state_->indexes_ready=true;
  }
  bool ok=mongoc_collection_update_one(state_->collection,filter.get(),update.get(),options.get(),&reply,&error);
  bson_destroy(&reply);if(!ok)Fail(error);
}
nlohmann::json EventStore::List(const std::string& channel,int limit) {
  if(channel.empty()||limit<1||limit>200)throw std::invalid_argument("Invalid event query");
  auto filter=Bson({{"channel_id",channel}});
  auto options=BsonOrdered({{"limit",limit},{"sort",{{"timestamp",-1},{"_id",-1}}}});
  std::lock_guard lock(state_->mutex);
  std::unique_ptr<mongoc_cursor_t,decltype(&mongoc_cursor_destroy)> cursor(
    mongoc_collection_find_with_opts(state_->collection,filter.get(),options.get(),nullptr),mongoc_cursor_destroy);
  nlohmann::json result=nlohmann::json::array();
  const bson_t* doc=nullptr;
  while(mongoc_cursor_next(cursor.get(),&doc)) {
    char* text=bson_as_relaxed_extended_json(doc,nullptr);
    try {
      auto item=nlohmann::json::parse(text);item.erase("_id");
      // Lease ownership is internal coordination data, not public history.
      for(const char* key:{"review_job","notification_job"})
        if(item.contains(key)&&item[key].is_object())item[key].erase("token");
      if(item.contains("notification_request")&&item["notification_request"].is_object())
        item["notification_request"].erase("endpoint");
      result.push_back(std::move(item));
    }
    catch(...){bson_free(text);throw;}
    bson_free(text);
  }
  bson_error_t error{};if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return result;
}
}

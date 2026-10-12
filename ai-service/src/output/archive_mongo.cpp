// Copyright AINVR.
#include "archive_mongo.hpp"
#include "history_deletions.hpp"
#include "archive_list_item.hpp"
#include <mongoc/mongoc.h>
#include <mutex>
#include <stdexcept>
namespace ainvr {
namespace {
void Init(){static std::once_flag once;std::call_once(once,[]{mongoc_init();});}
// Driver messages can contain connection details. Public errors deliberately
// expose numeric diagnostics only, never the URI or credentials.
void Fail(const bson_error_t& e){throw std::runtime_error("Archive Mongo error domain="+std::to_string(e.domain)+" code="+std::to_string(e.code));}
struct Bson {bson_t value;Bson(){bson_init(&value);}~Bson(){bson_destroy(&value);}};
struct Client {
  mongoc_client_pool_t* pool;mongoc_client_t* value;
  explicit Client(mongoc_client_pool_t* p):pool(p),value(mongoc_client_pool_pop(p)){if(!value)throw std::runtime_error("Archive Mongo pool unavailable");}
  ~Client(){mongoc_client_pool_push(pool,value);}
};
using Collection=std::unique_ptr<mongoc_collection_t,decltype(&mongoc_collection_destroy)>;
using Cursor=std::unique_ptr<mongoc_cursor_t,decltype(&mongoc_cursor_destroy)>;
}
struct ArchiveMongo::State {
  mongoc_client_pool_t* pool=nullptr;std::string database,collection;
  ~State(){if(pool)mongoc_client_pool_destroy(pool);}
};
ArchiveMongo::ArchiveMongo(const std::string& uri,const std::string& database,const std::string& collection):state_(std::make_unique<State>()){
  if(database.empty()||collection.empty())throw std::invalid_argument("Empty archive namespace");
  Init();bson_error_t error{};
  std::unique_ptr<mongoc_uri_t,decltype(&mongoc_uri_destroy)> parsed(mongoc_uri_new_with_error(uri.c_str(),&error),mongoc_uri_destroy);
  if(!parsed)throw std::invalid_argument("Invalid archive Mongo URI");
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_SERVERSELECTIONTIMEOUTMS,5000);
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_CONNECTTIMEOUTMS,5000);
  mongoc_uri_set_option_as_int32(parsed.get(),MONGOC_URI_SOCKETTIMEOUTMS,15000);
  state_->database=database;state_->collection=collection;
  state_->pool=mongoc_client_pool_new(parsed.get());if(!state_->pool)throw std::runtime_error("Cannot create archive Mongo pool");
  mongoc_client_pool_set_error_api(state_->pool,2);
}
ArchiveMongo::~ArchiveMongo()=default;
void ArchiveMongo::Put(const std::vector<uint8_t>& bytes){
  bson_t doc;size_t invalid=0;
  if(bytes.empty()||bytes.size()>16*1024*1024||!bson_init_static(&doc,bytes.data(),bytes.size())||!bson_validate(&doc,BSON_VALIDATE_UTF8,&invalid))
    throw std::invalid_argument("Invalid archive BSON");
  bson_iter_t id,name;
  if(!bson_iter_init_find(&id,&doc,"_id")||!BSON_ITER_HOLDS_OID(&id)||!bson_iter_init_find(&name,&doc,"image_id")||!BSON_ITER_HOLDS_UTF8(&name))
    throw std::invalid_argument("Missing archive identity");
  char hex[25];bson_oid_to_string(bson_iter_oid(&id),hex);
  if(std::string(bson_iter_utf8(&name,nullptr))!=hex)throw std::invalid_argument("Archive identity mismatch");
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Bson filter,opts,concern;BSON_APPEND_OID(&filter.value,"_id",bson_iter_oid(&id));BSON_APPEND_BOOL(&opts.value,"upsert",true);
  BSON_APPEND_INT32(&concern.value,"w",1);BSON_APPEND_BOOL(&concern.value,"j",true);BSON_APPEND_INT32(&concern.value,"wtimeout",5000);
  BSON_APPEND_DOCUMENT(&opts.value,"writeConcern",&concern.value);
  bson_error_t error{};bson_t reply;
  bool ok=mongoc_collection_replace_one(coll.get(),&filter.value,&doc,&opts.value,&reply,&error);bson_destroy(&reply);
  if(!ok)Fail(error);
}
std::optional<std::vector<uint8_t>> ArchiveMongo::Get(const std::string& image_id){
  if(image_id.size()!=24||!bson_oid_is_valid(image_id.c_str(),image_id.size()))throw std::invalid_argument("Invalid archive ID");
  bson_oid_t oid;bson_oid_init_from_string(&oid,image_id.c_str());Bson filter;BSON_APPEND_OID(&filter.value,"_id",&oid);
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Cursor cursor(mongoc_collection_find_with_opts(coll.get(),&filter.value,nullptr,nullptr),mongoc_cursor_destroy);
  const bson_t* doc=nullptr;std::optional<std::vector<uint8_t>> result;
  if(mongoc_cursor_next(cursor.get(),&doc)){const auto* p=bson_get_data(doc);result=std::vector<uint8_t>(p,p+doc->len);}
  bson_error_t error{};if(mongoc_cursor_error(cursor.get(),&error))Fail(error);return result;
}
int64_t ArchiveMongo::Count(){
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Bson filter; bson_error_t error{};
  auto count=mongoc_collection_count_documents(coll.get(),&filter.value,nullptr,nullptr,nullptr,&error);if(count<0)Fail(error);return count;
}
int64_t ArchiveMongo::ApplyDeletionRules(const std::string& text){
  const auto rules=nlohmann::json::parse(text);
  if(!rules.is_array())throw std::invalid_argument("Invalid deletion rules");
  uint64_t previous=0;
  // Validate the complete request before executing any destructive operation.
  for(const auto& rule:rules){
    auto epoch=rule.at("epoch");
    if(!epoch.is_number_unsigned()||epoch.get<uint64_t>()<=previous||epoch.get<uint64_t>()>uint64_t(INT64_MAX))throw std::invalid_argument("Invalid deletion epoch");
    ai_service::output::HistoryDeletions validation;validation.Add(rule.at("filter"));previous=epoch.get<uint64_t>();
  }
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  int64_t deleted=0;
  for(const auto& rule:rules){
    nlohmann::json generation={{"$or",nlohmann::json::array({{{"archive_epoch",{{"$lt",rule.at("epoch")}}}},{{"archive_epoch",{{"$exists",false}}}}})}};
    auto query=nlohmann::json({{"$and",nlohmann::json::array({rule.at("filter"),generation})}}).dump();
    bson_error_t error{};std::unique_ptr<bson_t,decltype(&bson_destroy)> filter(bson_new_from_json(reinterpret_cast<const uint8_t*>(query.data()),query.size(),&error),bson_destroy);
    if(!filter)throw std::invalid_argument("Invalid deletion BSON");
    Bson opts,concern;BSON_APPEND_INT32(&concern.value,"w",1);BSON_APPEND_BOOL(&concern.value,"j",true);BSON_APPEND_INT32(&concern.value,"wtimeout",5000);BSON_APPEND_DOCUMENT(&opts.value,"writeConcern",&concern.value);
    bson_t reply;bool ok=mongoc_collection_delete_many(coll.get(),filter.get(),&opts.value,&reply,&error);
    bson_iter_t count;if(ok&&bson_iter_init_find(&count,&reply,"deletedCount"))deleted+=bson_iter_as_int64(&count);
    bson_destroy(&reply);if(!ok)Fail(error);
  }
  return deleted;
}
int64_t ArchiveMongo::TrimHistory(int64_t max_count){
  if(max_count<0)throw std::invalid_argument("Negative archive retention limit");
  Client client(state_->pool);
  Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Bson filter,count_opts;BSON_APPEND_UTF8(&count_opts.value,"hint","_id_");
  bson_error_t error{};
  auto count=mongoc_collection_count_documents(coll.get(),&filter.value,&count_opts.value,nullptr,nullptr,&error);
  if(count<0)Fail(error);
  const auto excess=count-max_count;if(excess<=0)return 0;
  // Preserve the reference implementation's indexed oldest-ObjectId boundary.
  Bson opts,sort,projection;
  BSON_APPEND_INT32(&sort.value,"_id",1);BSON_APPEND_DOCUMENT(&opts.value,"sort",&sort.value);
  BSON_APPEND_INT64(&opts.value,"skip",excess-1);BSON_APPEND_INT64(&opts.value,"limit",1);
  BSON_APPEND_UTF8(&opts.value,"hint","_id_");
  BSON_APPEND_INT32(&projection.value,"_id",1);BSON_APPEND_DOCUMENT(&opts.value,"projection",&projection.value);
  Cursor cursor(mongoc_collection_find_with_opts(coll.get(),&filter.value,&opts.value,nullptr),mongoc_cursor_destroy);
  const bson_t* doc=nullptr;bson_iter_t id;bson_oid_t boundary{};
  bool found=mongoc_cursor_next(cursor.get(),&doc);
  if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  if(!found||!bson_iter_init_find(&id,doc,"_id")||!BSON_ITER_HOLDS_OID(&id))
    throw std::runtime_error("Archive retention boundary unavailable");
  bson_oid_copy(bson_iter_oid(&id),&boundary);
  Bson stale,range,write_opts,concern;
  BSON_APPEND_OID(&range.value,"$lte",&boundary);BSON_APPEND_DOCUMENT(&stale.value,"_id",&range.value);
  BSON_APPEND_INT32(&concern.value,"w",1);BSON_APPEND_BOOL(&concern.value,"j",true);
  BSON_APPEND_INT32(&concern.value,"wtimeout",5000);BSON_APPEND_DOCUMENT(&write_opts.value,"writeConcern",&concern.value);
  bson_t reply;bool ok=mongoc_collection_delete_many(coll.get(),&stale.value,&write_opts.value,&reply,&error);
  bson_iter_t deleted;int64_t removed=-1;
  if(ok&&bson_iter_init_find(&deleted,&reply,"deletedCount"))removed=bson_iter_as_int64(&deleted);
  bson_destroy(&reply);if(!ok)Fail(error);
  if(removed<0)throw std::runtime_error("Archive retention acknowledgement missing");
  return removed;
}
nlohmann::json ArchiveMongo::ListPage(std::optional<std::string> cursor_id,int limit,
 double min_confidence,std::optional<double> from_ts,std::optional<double> to_ts){
  using nlohmann::json;
  if(!std::isfinite(min_confidence)||(from_ts&&!std::isfinite(*from_ts))||(to_ts&&!std::isfinite(*to_ts)))
    throw std::invalid_argument("Non-finite snapshot query");
  limit=std::clamp(limit,1,100);min_confidence=std::clamp(min_confidence,0.0,1.0);
  json query=json::object();
  if(cursor_id){
    if(cursor_id->size()!=24||!bson_oid_is_valid(cursor_id->c_str(),cursor_id->size()))
      return {{"items",json::array()},{"next_cursor",nullptr}};
    query["_id"]={{"$lt",{{"$oid",*cursor_id}}}};
  }
  if(min_confidence>0)query["$or"]=json::array({{{"confidence",nullptr}},{{"confidence",{{"$gte",min_confidence}}}}});
  if(from_ts||to_ts){query["timestamp"]=json::object();if(from_ts)query["timestamp"]["$gte"]=*from_ts;if(to_ts)query["timestamp"]["$lte"]=*to_ts;}
  auto text=query.dump();bson_error_t error{};
  std::unique_ptr<bson_t,decltype(&bson_destroy)> filter(bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error),bson_destroy);
  if(!filter)throw std::invalid_argument("Invalid snapshot query");
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Bson opts,sort,projection;BSON_APPEND_INT32(&sort.value,"_id",-1);
  BSON_APPEND_DOCUMENT(&opts.value,"sort",&sort.value);BSON_APPEND_INT64(&opts.value,"limit",limit);
  BSON_APPEND_INT32(&projection.value,"image.data",0);BSON_APPEND_INT32(&projection.value,"original_image",0);
  BSON_APPEND_DOCUMENT(&opts.value,"projection",&projection.value);
  Cursor cursor(mongoc_collection_find_with_opts(coll.get(),filter.get(),&opts.value,nullptr),mongoc_cursor_destroy);
  json items=json::array();std::string last_id;int count=0;const bson_t* doc=nullptr;
  while(mongoc_cursor_next(cursor.get(),&doc)){
    bson_iter_t id;if(bson_iter_init_find(&id,doc,"_id")&&BSON_ITER_HOLDS_OID(&id)){
      char hex[25];bson_oid_to_string(bson_iter_oid(&id),hex);last_id=hex;
    }
    std::unique_ptr<char,decltype(&bson_free)> encoded(bson_as_relaxed_extended_json(doc,nullptr),bson_free);
    if(!encoded)throw std::runtime_error("Snapshot query serialization failed");
    auto raw=json::parse(encoded.get(),nullptr,false);
    if(!raw.is_discarded())items.push_back(DocToListItem(raw));
    ++count;
  }
  if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return {{"items",items},{"next_cursor",count==limit?json(last_id):json(nullptr)}};
}
std::optional<std::vector<uint8_t>> ArchiveMongo::GetImage(const std::string& image_id,bool original){
  // A missing or malformed image identifier is a not-found result, not a DB outage.
  if(image_id.size()!=24||!bson_oid_is_valid(image_id.c_str(),image_id.size()))return {};
  bson_oid_t oid;bson_oid_init_from_string(&oid,image_id.c_str());
  Bson filter,opts,projection;BSON_APPEND_OID(&filter.value,"_id",&oid);
  const char* field=original?"original_image.data":"image.data";
  BSON_APPEND_INT32(&projection.value,field,1);BSON_APPEND_DOCUMENT(&opts.value,"projection",&projection.value);
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Cursor cursor(mongoc_collection_find_with_opts(coll.get(),&filter.value,&opts.value,nullptr),mongoc_cursor_destroy);
  const bson_t* doc=nullptr;std::optional<std::vector<uint8_t>> result;
  if(mongoc_cursor_next(cursor.get(),&doc)){
    bson_iter_t root,data;
    if(bson_iter_init(&root,doc)&&bson_iter_find_descendant(&root,field,&data)&&BSON_ITER_HOLDS_BINARY(&data)){
      bson_subtype_t subtype;uint32_t size;const uint8_t* bytes;
      bson_iter_binary(&data,&subtype,&size,&bytes);result=std::vector<uint8_t>(bytes,bytes+size);
    }
  }
  bson_error_t error{};if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return result;
}
nlohmann::json ArchiveMongo::Heatmap(std::optional<double> from_ts,std::optional<double> to_ts,int bucket_s){
  using nlohmann::json;
  if((from_ts&&!std::isfinite(*from_ts))||(to_ts&&!std::isfinite(*to_ts)))
    throw std::invalid_argument("Non-finite snapshot time range");
  bucket_s=std::clamp(bucket_s,30,3600);
  json match=json::object();
  if(from_ts||to_ts){match["timestamp"]=json::object();if(from_ts)match["timestamp"]["$gte"]=*from_ts;if(to_ts)match["timestamp"]["$lte"]=*to_ts;}
  // Keep the reference aggregation, including a valid empty $match stage.
  json stages=json::array({{{"$match",match}},
    {{"$group",{{"_id",{{"$toInt",{{"$floor",{{"$divide",json::array({"$timestamp",bucket_s})}}}}}}},{"count",{{"$sum",1}}}}}},
    {{"$sort",{{"_id",1}}}},
    {{"$project",{{"_id",0},{"t",{{"$multiply",json::array({"$_id",bucket_s})}}},{"count",1}}}}});
  auto text=stages.dump();bson_error_t error{};
  std::unique_ptr<bson_t,decltype(&bson_destroy)> pipeline(bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error),bson_destroy);
  if(!pipeline)throw std::runtime_error("Invalid snapshot aggregation");
  Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
  Cursor cursor(mongoc_collection_aggregate(coll.get(),MONGOC_QUERY_NONE,pipeline.get(),nullptr,nullptr),mongoc_cursor_destroy);
  json buckets=json::array();const bson_t* doc=nullptr;
  while(mongoc_cursor_next(cursor.get(),&doc)){
    std::unique_ptr<char,decltype(&bson_free)> encoded(bson_as_relaxed_extended_json(doc,nullptr),bson_free);
    if(!encoded)throw std::runtime_error("Snapshot aggregation serialization failed");
    auto item=json::parse(encoded.get(),nullptr,false);if(!item.is_discarded())buckets.push_back(std::move(item));
  }
  if(mongoc_cursor_error(cursor.get(),&error))Fail(error);
  return {{"enabled",true},{"bucket_s",bucket_s},{"count",buckets.size()},{"buckets",buckets}};
}
nlohmann::json ArchiveMongo::Overview(int64_t max_count){
  using nlohmann::json;
  if(max_count<0)throw std::invalid_argument("Negative archive retention limit");
  json result={{"enabled",true},{"connected",false},{"last_error",nullptr},
    {"count",0},{"max_count",max_count},{"storage_bytes",0},
    {"earliest_timestamp",nullptr},{"latest_timestamp",nullptr}};
  try{
    Client client(state_->pool);Collection coll(mongoc_client_get_collection(client.value,state_->database.c_str(),state_->collection.c_str()),mongoc_collection_destroy);
    Bson filter,options;BSON_APPEND_UTF8(&options.value,"hint","_id_");bson_error_t error{};
    auto count=mongoc_collection_count_documents(coll.get(),&filter.value,&options.value,nullptr,nullptr,&error);
    if(count<0)Fail(error);
    int64_t bytes=0;Bson command,reply;BSON_APPEND_UTF8(&command.value,"collStats",state_->collection.c_str());
    if(mongoc_client_command_simple(client.value,state_->database.c_str(),&command.value,nullptr,&reply.value,&error)){
      bson_iter_t size;if(bson_iter_init_find(&size,&reply.value,"size"))bytes=bson_iter_as_int64(&size);
    }
    auto endpoint=[&](int direction)->json{
      Bson opts,sort,projection;BSON_APPEND_INT32(&sort.value,"_id",direction);
      BSON_APPEND_DOCUMENT(&opts.value,"sort",&sort.value);BSON_APPEND_INT64(&opts.value,"limit",1);
      BSON_APPEND_INT32(&projection.value,"timestamp",1);BSON_APPEND_DOCUMENT(&opts.value,"projection",&projection.value);
      Cursor cursor(mongoc_collection_find_with_opts(coll.get(),&filter.value,&opts.value,nullptr),mongoc_cursor_destroy);
      const bson_t* doc=nullptr;json timestamp=nullptr;
      if(mongoc_cursor_next(cursor.get(),&doc)){
        bson_iter_t time;if(bson_iter_init_find(&time,doc,"timestamp"))timestamp=bson_iter_as_double(&time);
      }
      if(mongoc_cursor_error(cursor.get(),&error))Fail(error);return timestamp;
    };
    auto earliest=endpoint(1),latest=endpoint(-1);
    result.update({{"connected",true},{"count",count},{"storage_bytes",bytes},
      {"earliest_timestamp",earliest},{"latest_timestamp",latest}});
  }catch(const std::exception&){result["last_error"]="Archive database unavailable";}
  return result;
}
}  // namespace ainvr

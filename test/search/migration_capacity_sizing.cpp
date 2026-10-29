// Software-only exact serialized-payload sizing for the existing migration fixture.
// No DB connection, files, BPU, service lifecycle or production limit changes.
#include "migration_sample.hpp"
#include <bson/bson.h>
#include <iostream>
#include <cstdio>
using namespace ainvr::search;
using Json=nlohmann::json;
namespace {
std::string Id(int n){char out[37];snprintf(out,sizeof(out),"20000000-0000-4000-8000-%012d",n);return out;}
uint64_t BsonBytes(const Sample&s,int64_t ordinal){
  const auto d=ComputeSampleContractDigest(s);
  Json j{{"_id",s.record.id},{"channel",s.record.channel},{"model",s.record.model},{"captured_ms",s.record.captured_ms},
    {"metadata",d.metadata},{"fingerprint",d.fingerprint},{"metadata_sha",d.metadata_sha},{"vector_sha",d.vector_sha},{"jpeg_sha",d.jpeg_sha},
    {"ordinal",ordinal},{"expires_at",{{"$date",{{"$numberLong",std::to_string(s.expires_ms)}}}}},{"bytes",{{"$numberLong","0"}}}};
  bson_error_t error{};const auto text=j.dump();auto doc=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),-1,&error);
  if(!doc)throw std::runtime_error("bson_size_failed");
  BSON_APPEND_BINARY(doc,"vector",BSON_SUBTYPE_BINARY,d.vector_bytes.data(),d.vector_bytes.size());
  BSON_APPEND_BINARY(doc,"jpeg",BSON_SUBTYPE_BINARY,s.jpeg.data(),s.jpeg.size());
  const auto bytes=doc->len;bson_destroy(doc);return bytes;
}
Json Row(uint64_t i,size_t source_dimensions){
  constexpr int64_t now=1793268000000;
  const RuntimeModelPin old{"siglip-so400m-i18n-full-int8",std::string(64,'a'),"search-v1-"+std::string(64,'a')},
    target{"siglip2-base-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')};
  Sample source;
  source.record={SampleStorageUuid("perf-source-v1",Json::array({50000,i})),Id(1),"processor","session","track-"+std::to_string(i),old.model_version,now-10000,false,{1,0}};
  source.record.vector.assign(source_dimensions,0);source.record.vector[0]=1;
  source.evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id",Id(100)},{"output_channel_id",source.record.channel},{"recording_channel_id",source.record.channel},
    {"stream_session_id","session"},{"frame_id",SampleStorageUuid("perf-frame-v1",Json::array({50000,i}))},{"source_pts_ns",std::to_string(source.record.captured_ms*1000000)},
    {"source_frame_index",std::to_string(i)},{"input_path","/live/in"},{"output_path","/live/out"},{"input_spec_version","synthetic-old-vector"},{"frame_width",1920},{"frame_height",1080}};
  source.jpeg={255,216,255,217};source.expires_ms=now+3600000;
  source.fingerprint=source.record.fingerprint=ComputeSampleContractDigest(source).fingerprint;
  std::vector<float> embedding(768);embedding[0]=1;
  const auto derivative=MakeReencodedSample(source,old,target,FindPackageSpec(target.package_id),embedding,source.fingerprint,SampleSha256(source.jpeg.data(),source.jpeg.size()),now);
  const auto&r=derivative.record;
  const Json metadata{{"id",r.id},{"channel",r.channel},{"processor",r.processor},{"session",r.session},{"track",r.track},{"model",r.model},
    {"captured_ms",r.captured_ms},{"scene",r.scene},{"fingerprint",r.fingerprint}};
  return{{"source_bson_bytes",BsonBytes(source,2*i+1)},{"target_bson_bytes",BsonBytes(derivative,2*i+2)},
    {"target_index_record_bytes",4+metadata.dump().size()+768*4}};
}
Json Case(uint64_t count,size_t source_dimensions=2){
  uint64_t source=0,target=0,index=0;
  Json groups=Json::array();
  for(uint64_t start=0,end=10;start<count;start=end,end*=10){
    const auto n=std::min(count,end)-start;const auto row=Row(start,source_dimensions);
    source+=n*row.at("source_bson_bytes").get<uint64_t>();
    target+=n*row.at("target_bson_bytes").get<uint64_t>();
    index+=n*row.at("target_index_record_bytes").get<uint64_t>();
    groups.push_back({{"first_index",start},{"rows",n},{"serialized_row_bytes",row}});
  }
  const auto shards=(count+9999)/10000;index+=24*shards;
  return{{"source_rows",count},{"target_rows",count},{"source_dimensions",source_dimensions},{"target_dimensions",768},{"total_mongo_documents",2*count},{"within_production_max_samples",2*count<=1000000},
    {"source_bson_bytes",source},{"target_bson_bytes",target},{"total_bson_bytes",source+target},{"target_index_data_bytes",index},
    {"source_day_partitions_at_10000_limit",shards},{"target_vector_bytes",count*768*4},{"groups",groups},
    {"excludes",Json::array({"Mongo indexes","WiredTiger overhead/compression","journal/preallocation","manifests","temporary/retired shard revisions","original JPEG payload beyond the four-byte synthetic marker"})}};
}
}
int main(){try{
  std::cout<<Json{{"schema_version","search-migration-capacity-sizing-v1"},{"hardware",false},{"measurement","exact serialized sizes for fixed timestamp and original throughput fixture field layout"},
    {"cases",Json::array({Case(50000),Case(500000),Case(1000000),Case(50000,1152),Case(500000,1152),Case(1000000,1152)})}}.dump(2)<<'\n';
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}

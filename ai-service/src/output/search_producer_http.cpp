#include "output/search_producer_http.hpp"
// Use AI's existing system httplib ABI, never the search server's newer header.
#include <httplib.h>
#include <openssl/rand.h>
#include <array>
#include <atomic>
#include <chrono>
#include <cctype>
#include <limits>
#include <set>
#include <string_view>
namespace ai_service::output {
namespace {
using Json=nlohmann::json;
using Sample=ainvr::search::Sample;
using Lease=config::SearchProducerLease;
using Source=config::SearchProducerSource;
using Candidate=SearchSamplingPolicy::Candidate;
using Receipt=SearchSamplingReceipt;
constexpr size_t kReceiptMax=16384,kMetadataMax=256*1024,kResponseMax=16384;
[[noreturn]] void Invalid(){throw std::invalid_argument("search_prepared_sample_invalid");}
bool Hex(const std::string& s){return s.size()==64&&std::all_of(s.begin(),s.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});}
bool Safe(const std::string& s,size_t max=128){return !s.empty()&&s.size()<=max&&std::all_of(s.begin(),s.end(),[](unsigned char c){
 return std::isalnum(c)||c=='-'||c=='_'||c=='.'||c==':';});}
bool Uuid(const std::string& s){
 if(s.size()!=36)return false;
 for(size_t i=0;i<s.size();++i){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}
 else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')||(s[i]>='A'&&s[i]<='F')))return false;}return true;
}
bool Alive(const Lease& lease,const SearchSamplingCurrent& current)noexcept{
 try{return lease.grant&&lease.IsCurrent()&&current&&current();}catch(...){return false;}
}
bool ValidLease(const Lease& lease){
 if(!lease.grant||!lease.IsCurrent())return false;
 const auto& g=*lease.grant;
 return g.endpoint=="http://127.0.0.1:8400"&&g.api_token.size()>=32&&g.api_token.size()<=512&&
  std::all_of(g.api_token.begin(),g.api_token.end(),[](unsigned char c){return c>32&&c<127;})&&Hex(g.revision)&&Safe(g.package_id)&&
  g.limits.image_max_bytes>=65536&&g.limits.image_max_bytes<=8388608;
}
bool Mapping(const Source& a,const Source& b){return a.channel_id==b.channel_id&&a.input_stream_id==b.input_stream_id&&
 a.processor_id==b.processor_id&&a.recording_channel_id==b.recording_channel_id&&a.input_path==b.input_path&&a.output_path==b.output_path;}
bool Authorized(const Source& source,const SearchEmbeddingSpace& space,const Candidate& candidate,const Lease& lease){
 if(candidate.frame.binding.source_input_id!=source.input_stream_id||candidate.frame.binding.processor_id!=source.processor_id||candidate.frame.source_pts_ns<0||candidate.frame.source_frame_index<0||
  candidate.frame.captured_ms<0||candidate.frame.captured_ms>9007199254740991LL||candidate.frame.binding.width<1||candidate.frame.binding.height<1||
  candidate.frame.binding.width>16384||candidate.frame.binding.height>16384||
  !ValidLease(lease)||lease.grant->package_id!=space.package_id||!Safe(space.model_version)||space.input_spec_version.empty()||space.input_spec_version.size()>512||
  !std::all_of(space.input_spec_version.begin(),space.input_spec_version.end(),[](unsigned char c){return c>=32&&c<127;}))return false;
 const auto i=lease.grant->sources.find(source.processor_id);
 return i!=lease.grant->sources.end()&&Mapping(i->second,source)&&(candidate.slot?i->second.object:i->second.scene);
}
void Keys(const Json& value,std::initializer_list<const char*> keys){
 if(!value.is_object()||value.size()!=keys.size())Invalid();
 for(const auto* k:keys)if(!value.contains(k))Invalid();
}
Json Parse(const std::string& text,size_t max){
 if(text.empty()||text.size()>max)Invalid();
 std::vector<std::set<std::string>> keys;
 return Json::parse(text,[&](int depth,Json::parse_event_t event,Json& value){
  if(depth<0||depth>8)Invalid();
  if(event==Json::parse_event_t::object_start){if(keys.size()<=size_t(depth))keys.resize(size_t(depth)+1);keys[size_t(depth)].clear();}
  if(event==Json::parse_event_t::key&&(!depth||keys.size()<size_t(depth)||!keys[size_t(depth)-1].insert(value.get<std::string>()).second))Invalid();
  return true;
 });
}
// Bounded metadata audit, also conservatively accounts for JSON/map allocations.
size_t MetadataBytes(const Json& value,const std::string& credential,size_t depth=0,size_t* visited=nullptr){
 size_t local=0;if(!visited)visited=&local;
 if(++*visited>512)Invalid();
 if(depth>8||value.is_binary()||value.is_discarded())Invalid();
 size_t bytes=144;
 if(value.is_object()){
  if(value.size()>64)Invalid();
  for(auto i=value.begin();i!=value.end();++i){
   std::string name;for(unsigned char c:i.key())if(c!='_'&&c!='-')name+=char(std::tolower(c));
   for(const auto* bad:{"vector","vectors","embedding","image","jpeg","pixels","body","headers","authorization","password","secret","apikey","apitoken","credentials","token","encodedbody","imagedata"})if(name==bad)Invalid();
   bytes+=i.key().capacity()+MetadataBytes(i.value(),credential,depth+1,visited);
  }
 }else if(value.is_array()){
  if(value.size()>64)Invalid();
  for(const auto& item:value)bytes+=MetadataBytes(item,credential,depth+1,visited);
 }else if(value.is_string()){
  const auto& s=value.get_ref<const std::string&>();
  if(s.size()>2048||s.find("://")!=std::string::npos||(!credential.empty()&&s.find(credential)!=std::string::npos)||
   std::any_of(s.begin(),s.end(),[](unsigned char c){return c<32||c==127;}))Invalid();
  bytes+=s.capacity();
 }else if(value.is_number_float()&&!std::isfinite(value.get<double>()))Invalid();
 if(bytes>65536)Invalid();
 return bytes;
}
void ValidateIdentity(const Json& metadata,const Source& source,const SearchEmbeddingSpace& space,const Candidate& candidate){
 Keys(metadata,{"id","channel_id","processor_id","stream_session_id","track_id","model_version","captured_ms","kind","evidence","expires_ms"});
 const auto& frame=candidate.frame;const auto& e=metadata.at("evidence");
 if(!metadata.at("id").is_string()||!Uuid(metadata.at("id").get<std::string>())||metadata.at("channel_id")!=source.channel_id||
  metadata.at("processor_id")!=source.processor_id||metadata.at("stream_session_id")!=frame.binding.stream_session_id||
  metadata.at("track_id")!=candidate.track_id||metadata.at("model_version")!=space.model_version||
  metadata.at("captured_ms")!=frame.captured_ms||metadata.at("kind")!=(candidate.slot?"object":"scene")||
  !metadata.at("expires_ms").is_number_integer()||metadata.at("expires_ms").get<int64_t>()<=frame.captured_ms||
  !e.is_object()||e.at("source_input_id")!=source.input_stream_id||e.at("output_channel_id")!=source.channel_id||
  e.at("recording_channel_id")!=source.recording_channel_id||e.at("input_path")!=source.input_path||e.at("output_path")!=source.output_path||
  e.at("stream_session_id")!=frame.binding.stream_session_id||e.at("source_pts_ns")!=std::to_string(frame.source_pts_ns)||
  e.at("source_frame_index")!=std::to_string(frame.source_frame_index)||e.at("frame_width")!=frame.binding.width||e.at("frame_height")!=frame.binding.height)Invalid();
 if(SearchSamplingPolicy::IsProbe(candidate)){
  if(!SearchSamplingPolicy::ProbeContractValid(candidate))Invalid();
  const auto& appearance=e.at("appearance");Keys(appearance,{"metric","reference_fingerprint","distance","threshold","threshold_experimental"});
  if(appearance.at("metric")!=kSearchAppearanceMetric||appearance.at("reference_fingerprint")!=candidate.probe_reference_fingerprint||
    !appearance.at("distance").is_number()||!appearance.at("threshold").is_number()||
    !std::isfinite(appearance.at("distance").get<double>())||appearance.at("distance").get<double>()<candidate.probe_threshold||
    appearance.at("distance").get<double>()>2||appearance.at("threshold")!=candidate.probe_threshold||appearance.at("threshold_experimental")!=Json(true))Invalid();
 }
}
std::string Nonce(){unsigned char bytes[16];if(RAND_bytes(bytes,sizeof(bytes))!=1)Invalid();const char* digits="0123456789abcdef";std::string s;
 for(auto b:bytes){s+=digits[b>>4];s+=digits[b&15];}return s;}
Json Metadata(const Sample& sample){const auto& r=sample.record;return {{"id",r.id},{"channel_id",r.channel},{"processor_id",r.processor},
 {"stream_session_id",r.session},{"track_id",r.track},{"model_version",r.model},{"captured_ms",r.captured_ms},
 {"kind",r.scene?"scene":"object"},{"evidence",sample.evidence},{"expires_ms",sample.expires_ms}};}
Receipt Unknown(const std::string& key){return {Receipt::Result::Unknown,"",key};}
bool PrewriteRejected(const SearchProducerHttpResponse& response){
 if(!response.complete_error_response)return false;
 // 507 storage_capacity is raised by the store BEFORE any insert (quota/sample-count check), so it is a definite not-stored.
 const char* code=response.status==503?"source_ingestion_paused":response.status==409?"source_frame_before_resume":
  response.status==507?"storage_capacity":nullptr;
 if(!code)return false;
 const auto body=Parse(response.body,kResponseMax);Keys(body,{"error"});
 return body.at("error")==code;
}
// Why a sample write ended without a Committed receipt (diagnostics; process-wide).
std::array<std::atomic<uint64_t>,12>& SubmitOutcomeCounters(){static std::array<std::atomic<uint64_t>,12> c;return c;}
void CountSubmit(size_t i)noexcept{SubmitOutcomeCounters()[i].fetch_add(1,std::memory_order_relaxed);}
class Operation final:public SearchSamplingOperation{
 public:
 Operation(std::shared_ptr<const Sample> sample,Lease lease,std::shared_ptr<SearchProducerHttpTransport> transport,
     std::string metadata,std::string query,std::string fingerprint,bool object,size_t bytes)
  :sample_(std::move(sample)),lease_(std::move(lease)),transport_(std::move(transport)),metadata_(std::move(metadata)),
   query_(std::move(query)),fingerprint_(std::move(fingerprint)),object_(object),bytes_(bytes){}
 size_t RetainedBytes()const noexcept override{return bytes_;}
 std::string ReceiptKey()const override{return sample_->record.id;}
 std::string ReceiptQuery()const override{return query_;}
 std::span<const float> Descriptor()const noexcept override{return sample_->record.vector;}
 Receipt Submit(const SearchSamplingCurrent& current)override{
  const auto key=ReceiptKey();
  if(started_.exchange(true)){CountSubmit(1);return Unknown(key);}
  if(!Alive(lease_,current)||!ValidLease(lease_)){CountSubmit(2);return {Receipt::Result::Rejected,"",key};}
  try{
   const auto response=transport_->Post(lease_,object_?"/v1/samples/slot":"/v1/samples",metadata_,&sample_->jpeg,current);
   if(!response.attempted){CountSubmit(3);return {Receipt::Result::Rejected,"",key};}
   if(PrewriteRejected(response)){CountSubmit(4);return {Receipt::Result::Rejected,"",key};}
   if(response.status!=200){CountSubmit(response.status==0?5:response.status>=500?6:7);return Unknown(key);}
   if(!Alive(lease_,current)){CountSubmit(8);return Unknown(key);}
   const auto ack=Parse(response.body,kResponseMax);Keys(ack,{"id","stored","fingerprint"});
   if(ack.at("id")!=key||ack.at("stored")!=Json(true)||ack.at("fingerprint")!=fingerprint_){CountSubmit(9);return Unknown(key);}
   CountSubmit(0);return {Receipt::Result::Committed,fingerprint_,key};
  }catch(...){CountSubmit(10);return Unknown(key);}
 }
 private:
 const std::shared_ptr<const Sample> sample_;
 const Lease lease_;
 const std::shared_ptr<SearchProducerHttpTransport> transport_;
 const std::string metadata_,query_,fingerprint_;
 const bool object_;const size_t bytes_;
 std::atomic<bool> started_{false};
};
class HttpTransport final:public SearchProducerHttpTransport{
 public:
 SearchProducerHttpResponse Post(const Lease& lease,const std::string& path,const std::string& metadata,
     const std::vector<uint8_t>* jpeg,const SearchSamplingCurrent& current)override{
  return Send(lease,path,metadata,jpeg,current,false);
 }
 SearchProducerHttpResponse PutCoverage(const Lease& lease,const std::string& metadata,
     const SearchSamplingCurrent& current)override{
  return Send(lease,"/v1/coverage/range",metadata,nullptr,current,true);
 }
 private:
 SearchProducerHttpResponse Send(const Lease& lease,const std::string& path,const std::string& metadata,
     const std::vector<uint8_t>* jpeg,const SearchSamplingCurrent& current,bool coverage){
  SearchProducerHttpResponse answer;
  try{
   if(!ValidLease(lease)||!Alive(lease,current)||metadata.empty()||metadata.size()>(coverage?4096:(jpeg?kMetadataMax:kReceiptMax))||
    (coverage?(path!="/v1/coverage/range"||jpeg):(jpeg?(path!="/v1/samples"&&path!="/v1/samples/slot"):(path!="/v1/samples/receipt"&&path!="/v1/samples/slot/receipt")))||
    (jpeg&&(jpeg->size()<4||jpeg->size()>size_t(lease.grant->limits.image_max_bytes))))return answer;
   const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
   const auto alive=[&]{return std::chrono::steady_clock::now()<deadline&&Alive(lease,current);};
   httplib::Client client("127.0.0.1",8400);
   client.set_connection_timeout(1);client.set_read_timeout(2);client.set_write_timeout(2);
   client.set_follow_location(false);client.set_keep_alive(false);client.set_decompress(false);
   httplib::Request request;request.method=coverage?"PUT":"POST";request.path=path;request.redirect_count_=0;
   request.headers.emplace("x-service-token",lease.grant->api_token);
   request.headers.emplace("x-search-config-revision",lease.grant->revision);
   request.headers.emplace("Accept","application/json");
   std::string first,middle,last;
   std::vector<std::string_view> segments;
   if(jpeg){
    const auto boundary="AINVR-search-"+Nonce();
    first="--"+boundary+"\r\nContent-Disposition: form-data; name=\"metadata\"; filename=\"metadata.json\"\r\nContent-Type: application/json\r\n\r\n";
    middle="\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
    last="\r\n--"+boundary+"--\r\n";
    request.headers.emplace("Content-Type","multipart/form-data; boundary="+boundary);
    segments={first,metadata,middle,std::string_view(reinterpret_cast<const char*>(jpeg->data()),jpeg->size()),last};
   }else{request.headers.emplace("Content-Type","application/json");segments={metadata};}
   size_t total=0;for(const auto part:segments)total+=part.size();
   // System httplib 0.10's Request exposes these provider fields. This is the
   // same ABI as the AI service, and avoids an extra full-image body copy while
   // retaining a response receiver (its Post overloads cannot combine both).
   request.content_length_=total;
   request.content_provider_=[&](size_t offset,size_t count,httplib::DataSink& sink){
    if(!alive()||offset>total||count>total-offset)return false;
    for(const auto segment:segments){if(offset>=segment.size()){offset-=segment.size();continue;}
     const auto length=std::min(count,segment.size()-offset);
     if(length&&!sink.write(segment.data()+offset,length))return false;
     count-=length;offset=0;if(!count)break;
    }return count==0;
   };
   bool error_headers=false;
   request.response_handler=[&](const httplib::Response& response){
    answer.status=response.status;
    if(!alive()||response.get_header_value("Content-Encoding")!="")return false;
    if(response.status!=200){
     const auto type=response.get_header_value("Content-Type");
     error_headers=jpeg&&(response.status==503||response.status==409||response.status==507)&&
      response.get_header_value_count("Content-Type")==1&&(type=="application/json"||type=="application/json; charset=utf-8")&&
      response.get_header_value_count("Content-Encoding")==0&&response.get_header_value_count("Location")==0&&
      response.get_header_value_count("Content-Length")<=1&&
      !(response.has_header("Content-Length")&&response.has_header("Transfer-Encoding"));
     if(!error_headers)return false;
    }
    const auto length=response.get_header_value("Content-Length");
    if(!length.empty()){
     if(length.size()>6||!std::all_of(length.begin(),length.end(),[](unsigned char c){return c>='0'&&c<='9';})||std::stoul(length)>kResponseMax)return false;
    }return true;
   };
   request.content_receiver=[&](const char* data,size_t count,uint64_t,uint64_t){
    if(!alive()||count>kResponseMax-answer.body.size())return false;
    answer.body.append(data,count);return true;
   };
   if(!alive())return answer;
   answer.attempted=true;
   const auto response=client.send(request);
   if(!response||(response->status!=200&&!error_headers)){answer.body.clear();return answer;}
   answer.complete_error_response=error_headers;
   return answer;
  }catch(...){answer.body.clear();return answer;}
 }
};
} // namespace
std::array<uint64_t,12> SearchSubmitOutcomes(){std::array<uint64_t,12> out{};for(size_t i=0;i<12;++i)out[i]=SubmitOutcomeCounters()[i].load(std::memory_order_relaxed);return out;}
std::shared_ptr<SearchProducerHttpTransport> MakeSearchProducerHttpTransport(){return std::make_shared<HttpTransport>();}
SearchProducerHttp::SearchProducerHttp(std::shared_ptr<SearchProducerHttpTransport> transport)
 :transport_(transport?std::move(transport):MakeSearchProducerHttpTransport()){}
std::shared_ptr<SearchSamplingOperation> SearchProducerHttp::Prepare(std::shared_ptr<const Sample> sample,const Source& source,
    const SearchEmbeddingSpace& space,const Lease& lease,const Candidate& candidate){
 try{
  if(!sample||!Authorized(source,space,candidate,lease)||candidate.slot!=sample->track_slot||
   (candidate.slot&&(*candidate.slot>7||(!candidate.expected_fingerprint.empty()&&!Hex(candidate.expected_fingerprint))))||
   sample->record.vector.empty()||sample->record.vector.size()>4096||sample->record.vector.capacity()>4096||sample->jpeg.size()<4||
   sample->jpeg.capacity()>size_t(lease.grant->limits.image_max_bytes)||sample->jpeg.front()!=255||sample->jpeg[1]!=216||
   sample->jpeg[sample->jpeg.size()-2]!=255||sample->jpeg.back()!=217)Invalid();
  (void)ainvr::search::NormalizeVector(sample->record.vector,sample->record.vector.size());
  if(sample->expires_ms>sample->record.captured_ms+lease.grant->limits.retention_days*86400000LL)Invalid();
  const auto evidence_bytes=MetadataBytes(sample->evidence,lease.grant->api_token);
  auto metadata=Metadata(*sample);ValidateIdentity(metadata,source,space,candidate);
  (void)MetadataBytes(metadata,lease.grant->api_token);
  const auto digest=ainvr::search::ComputeSampleContractDigest(*sample);
  if(!sample->fingerprint.empty()&&sample->fingerprint!=digest.fingerprint)Invalid();
  Json query={{"sample",metadata},{"request_fingerprint",digest.fingerprint}};
  std::string token;
  if(candidate.slot){token=Nonce();query["slot"]=*candidate.slot;query["replacement_token"]=token;}
  const auto frozen_query=query.dump();if(frozen_query.size()>kReceiptMax)Invalid();
  metadata["vector"]=sample->record.vector;
  if(candidate.slot)metadata={{"sample",std::move(metadata)},{"slot",*candidate.slot},{"expected_fingerprint",candidate.expected_fingerprint},{"replacement_token",token}};
  const auto frozen_metadata=metadata.dump();if(frozen_metadata.size()>kMetadataMax)Invalid();
  size_t bytes=sample->jpeg.capacity()+sample->record.vector.capacity()*sizeof(float)+evidence_bytes+
   frozen_metadata.capacity()+frozen_query.capacity()+4096;
  for(const auto* value:{&sample->record.id,&sample->record.channel,&sample->record.processor,&sample->record.session,
      &sample->record.track,&sample->record.model,&sample->record.fingerprint,&sample->fingerprint}) {
    if(value->capacity()>65536)Invalid();
    bytes+=value->capacity();
  }
  if(bytes>size_t(lease.grant->limits.image_max_bytes)+65536)Invalid();
  return std::make_shared<Operation>(std::move(sample),lease,transport_,frozen_metadata,frozen_query,digest.fingerprint,candidate.slot.has_value(),bytes);
 }catch(...){Invalid();}
}
Receipt SearchProducerHttp::Reconcile(const Candidate& candidate,const Source& source,const SearchEmbeddingSpace& space,
    const std::string& key,const std::string& query,const Lease& lease,const SearchSamplingCurrent& current){
 try{
  if(!Authorized(source,space,candidate,lease)||!Alive(lease,current))return Unknown(key);
  const auto body=Parse(query,kReceiptMax);
  if(candidate.slot)Keys(body,{"sample","slot","replacement_token","request_fingerprint"});
  else Keys(body,{"sample","request_fingerprint"});
  ValidateIdentity(body.at("sample"),source,space,candidate);(void)MetadataBytes(body,lease.grant->api_token);
  if(body.at("sample").at("id")!=key||!Hex(body.at("request_fingerprint").get<std::string>())||
   (candidate.slot&&(!body.at("slot").is_number_integer()||body.at("slot").get<int64_t>()!=int64_t(*candidate.slot)||
     !Safe(body.at("replacement_token").get<std::string>()))))return Unknown(key);
  const auto response=transport_->Post(lease,candidate.slot?"/v1/samples/slot/receipt":"/v1/samples/receipt",query,nullptr,current);
  if(!response.attempted||response.status!=200||!Alive(lease,current))return Unknown(key);
  const auto ack=Parse(response.body,kResponseMax);Keys(ack,{"status","fingerprint"});
  if(ack.at("status")!="committed"||ack.at("fingerprint")!=body.at("request_fingerprint"))return Unknown(key);
  return {Receipt::Result::Committed,body.at("request_fingerprint"),key};
 }catch(...){return Unknown(key);}
}
bool SearchProducerHttp::PublishCoverage(const SearchCoverageRange& range,const Lease& lease,const SearchSamplingCurrent& current){
 try{
  const auto& scope=range.scope;
  if(!ValidLease(lease)||!Alive(lease,current)||scope.package_id!=lease.grant->package_id||!Safe(scope.model_version)||
    !Safe(scope.stream_session_id)||!Uuid(scope.source.channel_id)||range.from_ms<0||range.to_ms<=range.from_ms||
    range.to_ms-range.from_ms>60000||range.to_ms>9007199254740991LL||range.expires_ms<=range.to_ms||
    range.expires_ms>range.to_ms+lease.grant->limits.retention_days*86400000LL)return false;
  const auto i=lease.grant->sources.find(scope.source.processor_id);
  if(i==lease.grant->sources.end()||!Mapping(i->second,scope.source)||(scope.scene?!i->second.scene:!i->second.object))return false;
  const auto identity=Json::array({scope.source.input_stream_id,scope.source.channel_id,scope.source.processor_id,
    scope.source.recording_channel_id,scope.source.input_path,scope.source.output_path,scope.stream_session_id,
    scope.model_version,scope.scene,range.from_ms,range.to_ms});
  const auto id=ainvr::search::SampleStorageUuid("ainvr-search-coverage-v1",identity);
  const char* state=range.state==SearchCoverageRange::State::Sampled?"sampled":
    range.state==SearchCoverageRange::State::Gap?"gap":"pending";
  const Json metadata={{"id",id},{"model_version",scope.model_version},{"channel_id",scope.source.channel_id},
    {"from_ms",range.from_ms},{"to_ms",range.to_ms},{"kind",scope.scene?"scene":"object"},
    {"state",state},{"expires_ms",range.expires_ms}};
  const auto response=transport_->PutCoverage(lease,metadata.dump(),current);
  if(!response.attempted||response.status!=200||!Alive(lease,current))return false;
  const auto ack=Parse(response.body,4096);Keys(ack,{"stored"});return ack.at("stored")==Json(true);
 }catch(...){return false;}
}
} // namespace ai_service::output

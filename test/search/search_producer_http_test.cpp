#include "output/search_producer_http.hpp"
#include <arpa/inet.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <atomic>
#include <fstream>
#include <iostream>
#include <thread>
using namespace ai_service::output;
using namespace ai_service::config;
using Json=nlohmann::json;
using Sample=ainvr::search::Sample;
using Receipt=SearchSamplingReceipt;
namespace {
size_t checks=0;
void Check(bool condition,const char* reason){++checks;if(!condition)throw std::runtime_error(reason);}
template<class F>void Reject(F f){try{f();}catch(const std::invalid_argument& e){Check(std::string(e.what())=="search_prepared_sample_invalid","unbounded_error");return;}throw std::runtime_error("invalid_prepare_accepted");}
struct Fixture{
 const std::string input="00000000-0000-4000-8000-000000000001",output="00000000-0000-4000-8000-000000000002";
 std::chrono::steady_clock::time_point now{};
 std::shared_ptr<SearchProducerGrantAuthority> authority;
 Json doc;
 SearchProducerSource source;
 SearchEmbeddingSpace space{"siglip2-base-full-int8","model-v1","image-area;gemma-pad0"};
 SearchSamplingPolicy::Candidate candidate;
 std::shared_ptr<Sample> sample=std::make_shared<Sample>();
 Fixture(bool scene=false){
  doc={{"enabled",true},{"reason",nullptr},{"endpoint","http://127.0.0.1:8400"},{"api_token",std::string(64,'b')},
   {"revision",std::string(64,'a')},{"model",{{"package_id",space.package_id}}},{"valid_for_ms",30000},
   {"limits",{{"producer_queue",1},{"producer_bytes",134217728},{"image_max_bytes",8388608},{"retention_days",30}}},
   {"sampling",{{"mode","all"},{"channel_ids",Json::array()},{"object",true},{"scene",true},{"object_interval_ms",1000},
    {"scene_active_interval_ms",10000},{"scene_static_interval_ms",60000},{"scene_change_min_interval_ms",3000},{"track_slots",8}}},
   {"sources",Json::array({{{"channel_id",output},{"input_stream_id",input},{"processor_id","processor"},
    {"recording_channel_id",output},{"input_path","/live/raw"},{"output_path","/live/ai"},{"object",true},{"scene",true}}})}};
  authority=std::make_shared<SearchProducerGrantAuthority>([this]{return now;});authority->Start();Renew();source=Lease().grant->sources.at("processor");
  candidate.token=1;candidate.frame={{input,"processor","session",16,8},1000000000,7,1000,"active"};
  candidate.track_id=scene?"":"track";if(!scene)candidate.slot=0;
  auto& r=sample->record;r.id="00000000-0000-4000-8000-000000000003";r.channel=output;r.processor="processor";
  r.session="session";r.track=candidate.track_id;r.model=space.model_version;r.captured_ms=1000;r.scene=scene;r.vector={1,0};
  sample->jpeg={255,216,255,217};sample->expires_ms=61000;sample->track_slot=candidate.slot;
  sample->evidence={{"source_input_id",input},{"output_channel_id",output},{"recording_channel_id",output},
   {"input_path","/live/raw"},{"output_path","/live/ai"},{"frame_id","00000000-0000-4000-8000-000000000004"},
   {"schema_version","1.0"},{"role","match"},{"stream_session_id","session"},{"source_pts_ns","1000000000"},
   {"source_frame_index","7"},{"frame_width",16},{"frame_height",8}};
 }
 void Renew(){Check(authority->Install(ParseSearchProducerGrant(doc),now),"fixture_grant");}
 SearchProducerLease Lease(){auto lease=authority->Read();if(!lease)throw std::runtime_error("fixture_lease");return *lease;}
 std::string Fingerprint(){return ainvr::search::ComputeSampleContractDigest(*sample).fingerprint;}
 Json Ack(){return {{"id",sample->record.id},{"stored",true},{"fingerprint",Fingerprint()}};}
};
struct Fake:SearchProducerHttpTransport{
 SearchProducerHttpResponse answer{true,200,""};
 bool fail=false;size_t calls=0;
 std::string path,metadata,key,revision;bool has_image=false;
 std::function<void()> on_call;
 SearchProducerHttpResponse Post(const SearchProducerLease& lease,const std::string& p,const std::string& m,
  const std::vector<uint8_t>* image,const SearchSamplingCurrent&)override{
  ++calls;path=p;metadata=m;key=lease.grant->api_token;revision=lease.grant->revision;has_image=image;
  if(on_call)on_call();
  if(fail)throw std::runtime_error("must_not_escape_token");
  return answer;
 }
 SearchProducerHttpResponse PutCoverage(const SearchProducerLease& lease,const std::string& metadata,const SearchSamplingCurrent& current)override{
  return Post(lease,"/v1/coverage/range",metadata,nullptr,current);
 }
};
struct Wire{
 int listener=-1;std::thread thread;std::exception_ptr failure;std::string request;
 explicit Wire(std::string response,bool stall=false){
  listener=socket(AF_INET,SOCK_STREAM|SOCK_CLOEXEC,0);if(listener<0)throw std::runtime_error("fixture_socket");
  int one=1;setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&one,sizeof(one));sockaddr_in address{};address.sin_family=AF_INET;
  address.sin_port=htons(8400);inet_pton(AF_INET,"127.0.0.1",&address.sin_addr);
  if(bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof(address))||listen(listener,1)){close(listener);listener=-1;throw std::runtime_error("fixture_bind_8400_failed_not_a_pass");}
  thread=std::thread([this,response=std::move(response),stall]{
   int client=-1;
   try{
    pollfd ready{listener,POLLIN,0};if(poll(&ready,1,4000)!=1)throw std::runtime_error("fixture_accept_timeout");
    client=accept4(listener,nullptr,nullptr,SOCK_CLOEXEC);if(client<0)throw std::runtime_error("fixture_accept");
    timeval timeout{4,0};setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    size_t expected=0;char part[257];
    for(;;){auto count=recv(client,part,sizeof(part),0);if(count<=0)throw std::runtime_error("fixture_request_truncated");
     request.append(part,size_t(count));if(request.size()>9*1024*1024)throw std::runtime_error("fixture_request_limit");
     const auto end=request.find("\r\n\r\n");if(end!=std::string::npos){
      if(!expected){const auto start=request.find("Content-Length: ");if(start==std::string::npos)throw std::runtime_error("fixture_length_missing");
       expected=end+4+std::stoul(request.substr(start+16));}
      if(request.size()>=expected)break;
     }
    }
    for(size_t offset=0;offset<response.size();){const auto n=send(client,response.data()+offset,std::min(size_t(79),response.size()-offset),MSG_NOSIGNAL);
     if(n<=0)break;
     offset+=size_t(n);}
    if(stall)std::this_thread::sleep_for(std::chrono::milliseconds(2300));
   }catch(...){failure=std::current_exception();}
   if(client>=0)close(client);
  });
 }
 ~Wire(){if(thread.joinable())thread.join();if(listener>=0)close(listener);}
 std::string Finish(){if(thread.joinable())thread.join();if(failure)std::rethrow_exception(failure);return request;}
};
std::string Http(const std::string& body,int status=200,const std::string& type="application/json",const std::string& extra=""){
 return "HTTP/1.1 "+std::to_string(status)+" fixture\r\n"+(type.empty()?"":"Content-Type: "+type+"\r\n")+
  "Content-Length: "+std::to_string(body.size())+"\r\n"+extra+"Connection: close\r\n\r\n"+body;}
std::string Body(const std::string& wire){const auto n=wire.find("\r\n\r\n");Check(n!=std::string::npos,"wire_headers");return wire.substr(n+4);}
} // namespace
int main(){try{
 const auto yes=[] {return true;};
 if(const auto* file=getenv("AINVR_SEARCH_HTTP_FIXTURE_PID")){std::ofstream pid(file);pid<<getpid()<<'\n';if(!pid)throw std::runtime_error("fixture_pid_file");}
 for(bool scene:{false,true}){
  Fixture f(scene);auto transport=std::make_shared<Fake>();transport->answer.body=f.Ack().dump();SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);const auto query=operation->ReceiptQuery();const auto parsed=Json::parse(query);
  Check(parsed.at("sample").at("id")==f.sample->record.id&&parsed.at("sample").at("expires_ms")==61000,"receipt_original_random_metadata");
  Check(!parsed.at("sample").contains("vector")&&query.find(std::string(64,'b'))==std::string::npos,"receipt_retained_vector_or_credential");
  Check(operation->Submit(yes).result==Receipt::Result::Committed,"valid_ack_not_committed");
  Check(transport->path==(scene?"/v1/samples":"/v1/samples/slot")&&transport->has_image,"wrong_write_route");
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==1,"operation_automatically_resent");
  transport->answer.body=Json{{"status","committed"},{"fingerprint",f.Fingerprint()}}.dump();
  f.doc["revision"]=std::string(64,'c');f.doc["api_token"]=std::string(64,'d');f.Renew();
  Check(http.Reconcile(f.candidate,f.source,f.space,operation->ReceiptKey(),query,f.Lease(),yes).result==Receipt::Result::Committed,"new_lease_receipt_failed");
  Check(transport->metadata==query&&!transport->has_image&&transport->key==std::string(64,'d')&&transport->revision==std::string(64,'c'),"receipt_recomputed_metadata_or_old_credentials");
  const auto calls=transport->calls;auto wrong=f.source;wrong.input_stream_id="00000000-0000-4000-8000-000000000099";
  Check(http.Reconcile(f.candidate,wrong,f.space,operation->ReceiptKey(),query,f.Lease(),yes).result==Receipt::Result::Unknown&&transport->calls==calls,"foreign_mapping_queried_receipt");
  for(const char* state:{"not_found","deleted","expired","replaced","scope_mismatch","write_mismatch"}){
   transport->answer.body=Json{{"status",state},{"fingerprint",nullptr}}.dump();
   Check(http.Reconcile(f.candidate,f.source,f.space,operation->ReceiptKey(),query,f.Lease(),yes).result==Receipt::Result::Unknown,"negative_receipt_faked_rejection");
  }
 }
 {
  Fixture f;auto transport=std::make_shared<Fake>();SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  transport->answer={false,0,""};
  Check(operation->Submit(yes).result==Receipt::Result::Rejected,"proven_prewrite_failure_not_rejected");
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==1,"proven_rejection_resubmitted");
  const auto query=operation->ReceiptQuery(),key=operation->ReceiptKey();
  for(int invalid=0;invalid<5;++invalid){
   std::string changed=query;
   if(invalid==0)changed="";
   if(invalid==1)changed=std::string(17000,'x');
   if(invalid==2){auto body=Json::parse(query);body["sample"]["vector"]={1,0};changed=body.dump();}
   if(invalid==3){auto body=Json::parse(query);body["sample"]["evidence"]["api_token"]="secret";changed=body.dump();}
   if(invalid==4)changed=std::string("{\"sample\":{\"vector\":[1,2]},")+query.substr(1);
   const auto before=transport->calls;
   Check(http.Reconcile(f.candidate,f.source,f.space,key,changed,f.Lease(),yes).result==Receipt::Result::Unknown&&transport->calls==before,"bad_receipt_metadata_sent");
  }
  for(const auto& response:std::vector<SearchProducerHttpResponse>{{true,403,""},{true,409,""},{true,503,""},
      {true,200,"{broken"},{true,200,Json{{"status","committed"},{"fingerprint",std::string(64,'f')}}.dump()}}){
   transport->answer=response;
   Check(http.Reconcile(f.candidate,f.source,f.space,key,query,f.Lease(),yes).result==Receipt::Result::Unknown,"bad_receipt_ack_confirmed");
   Check(!transport->has_image&&transport->path=="/v1/samples/slot/receipt","receipt_resubmitted_write");
  }
 }
 for(bool scene:{false,true})for(const auto& response:std::vector<SearchProducerHttpResponse>{
   {true,503,Json{{"error","source_ingestion_paused"}}.dump(),true},
   {true,409,Json{{"error","source_frame_before_resume"}}.dump(),true},
   {true,507,Json{{"error","storage_capacity"}}.dump(),true}}){
  Fixture f(scene);auto transport=std::make_shared<Fake>();transport->answer=response;SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Check(operation->Submit(yes).result==Receipt::Result::Rejected,"verified_prewrite_response_not_rejected");
  f.authority->Invalidate();
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==1,"rejected_operation_retried_after_revocation");
 }
 for(const auto& response:std::vector<SearchProducerHttpResponse>{
   {true,503,Json{{"error","source_ingestion_paused"}}.dump(),false},
   {true,409,Json{{"error","source_frame_before_resume"}}.dump(),false},
   {true,503,Json{{"error","service_unavailable"}}.dump(),true},
   {true,507,Json{{"error","service_unavailable"}}.dump(),true},
   {true,507,Json{{"error","storage_capacity"}}.dump(),false},
   {true,503,Json{{"error","storage_capacity"}}.dump(),true},
   {true,503,Json{{"error","source_frame_before_resume"}}.dump(),true},
   {true,409,Json{{"error","source_ingestion_paused"}}.dump(),true},
   {true,400,Json{{"error","source_frame_before_resume"}}.dump(),true},
   {true,503,Json{{"error","source_ingestion_paused"},{"extra",true}}.dump(),true},
   {true,503,"{\"error\":\"source_ingestion_paused\",\"error\":\"source_ingestion_paused\"}",true},
   {true,503,"{broken",true},{true,503,Json{{"error",true}}.dump(),true},
   {true,503,std::string(17000,'x'),true}}){
  Fixture f;auto transport=std::make_shared<Fake>();transport->answer=response;SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Check(operation->Submit(yes).result==Receipt::Result::Unknown,"unproven_error_response_became_rejected");
  f.authority->Invalidate();Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==1,"unknown_operation_revocation_became_rejected");
 }
 for(int invalid=0;invalid<12;++invalid){
  Fixture f;auto transport=std::make_shared<Fake>();transport->answer.body=f.Ack().dump();SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  if(invalid<5)transport->answer.status=std::vector<int>{400,403,409,429,503}[invalid];
  if(invalid==5)transport->answer.body="{broken";
  if(invalid==6){auto ack=f.Ack();ack["id"]="wrong";transport->answer.body=ack.dump();}
  if(invalid==7){auto ack=f.Ack();ack["stored"]=false;transport->answer.body=ack.dump();}
  if(invalid==8){auto ack=f.Ack();ack["fingerprint"]=std::string(64,'f');transport->answer.body=ack.dump();}
  if(invalid==9)transport->fail=true;
  if(invalid==10)transport->answer.body=std::string(17000,'x');
  if(invalid==11)transport->on_call=[&]{f.authority->Invalidate();};
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==1,"uncertain_write_claimed_rejection_or_success");
  Check(operation->Submit(yes).result!=Receipt::Result::Committed&&transport->calls==1,"uncertain_write_resent");
 }
 {
  Fixture f;auto transport=std::make_shared<Fake>();SearchProducerHttp http(transport);auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Check(operation->Submit([]{return false;}).result==Receipt::Result::Rejected&&transport->calls==0,"stale_frame_wrote");
  f.now+=std::chrono::seconds(31);
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==0,"repeat_stale_operation_faked_new_rejection");
 }
 {
  Fixture f;auto transport=std::make_shared<Fake>();SearchProducerHttp http(transport);
  auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);f.now+=std::chrono::seconds(31);
  Check(operation->Submit(yes).result==Receipt::Result::Rejected&&transport->calls==0,"first_expired_operation_wrote");
  Check(operation->Submit(yes).result==Receipt::Result::Unknown&&transport->calls==0,"expired_operation_was_not_one_shot");
 }
 for(int invalid=0;invalid<8;++invalid){
  Fixture f;auto transport=std::make_shared<Fake>();SearchProducerHttp http(transport);
  if(invalid==0)f.sample->record.vector={0,0};
  if(invalid==1)f.sample->track_slot=2;
  if(invalid==2)f.sample->evidence["api_token"]=std::string(64,'b');
  if(invalid==3)f.sample->evidence["image"]="encoded";
  if(invalid==4)f.sample->evidence["extra"]=std::string(17000,'x');
  if(invalid==5)f.sample->fingerprint=std::string(64,'a');
  if(invalid==6)f.sample->evidence["source_pts_ns"]="999";
  if(invalid==7)f.sample->jpeg={0,1,2,3};
  Reject([&]{http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);});Check(transport->calls==0,"invalid_prepare_wrote");
 }
 for(bool scene:{false,true}){
  Fixture f(scene);if(!scene){f.sample->jpeg.resize(2*1024*1024,0x42);f.sample->jpeg[0]=255;f.sample->jpeg[1]=216;f.sample->jpeg[f.sample->jpeg.size()-2]=255;f.sample->jpeg.back()=217;}
  SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Wire server(Http(f.Ack().dump()));Check(operation->Submit(yes).result==Receipt::Result::Committed,"real_http_ack_failed");const auto wire=server.Finish(),body=Body(wire);
  Check(wire.rfind(scene?"POST /v1/samples ":"POST /v1/samples/slot ",0)==0,"wire_route");
  Check(wire.find("x-service-token: "+std::string(64,'b'))!=std::string::npos&&wire.find("x-search-config-revision: "+std::string(64,'a'))!=std::string::npos,"wire_identity_headers");
  Check(body.find(std::string(64,'b'))==std::string::npos&&body.find("name=\"metadata\"")!=std::string::npos&&body.find("name=\"image\"")!=std::string::npos,"wire_credential_or_missing_parts");
  Check(body.find(std::string(reinterpret_cast<const char*>(f.sample->jpeg.data()),f.sample->jpeg.size()))!=std::string::npos,"streamed_jpeg_changed");
 }
 {
  Fixture f;SearchProducerHttp http;const auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);const auto query=operation->ReceiptQuery();
  f.doc["revision"]=std::string(64,'c');f.doc["api_token"]=std::string(64,'d');f.Renew();
  Wire server(Http(Json{{"status","committed"},{"fingerprint",f.Fingerprint()}}.dump()));
  Check(http.Reconcile(f.candidate,f.source,f.space,operation->ReceiptKey(),query,f.Lease(),yes).result==Receipt::Result::Committed,"wire_receipt_failed");
  const auto wire=server.Finish();Check(Body(wire)==query&&wire.rfind("POST /v1/samples/slot/receipt ",0)==0,"wire_receipt_changed");
  Check(wire.find("x-service-token: "+std::string(64,'d'))!=std::string::npos,"wire_receipt_used_old_key");
 }
 for(const auto& [status,code]:std::vector<std::pair<int,std::string>>{{503,"source_ingestion_paused"},{409,"source_frame_before_resume"}}){
  for(bool scene:{false,true}){
   Fixture f(scene);SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
   Wire server(Http(Json{{"error",code}}.dump(),status,"application/json; charset=utf-8"));
   Check(operation->Submit(yes).result==Receipt::Result::Rejected,"wire_prewrite_error_not_rejected");(void)server.Finish();
   f.authority->Invalidate();Check(operation->Submit(yes).result==Receipt::Result::Unknown,"wire_rejection_retried_after_expiry");
  }
  Fixture f;SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Wire receipt(Http(Json{{"error",code}}.dump(),status));
  Check(http.Reconcile(f.candidate,f.source,f.space,operation->ReceiptKey(),operation->ReceiptQuery(),f.Lease(),yes).result==Receipt::Result::Unknown,
    "wire_receipt_error_faked_rejection");(void)receipt.Finish();
 }
 {
  const auto body=Json{{"error","source_ingestion_paused"}}.dump();
  for(const auto& reply:std::vector<std::string>{Http(body,503,""),Http(body,503,"text/plain"),
    Http(body,503,"application/json","Content-Type: application/json\r\n"),
    Http(body,503,"application/json","Content-Encoding: gzip\r\n"),
    Http(body,503,"application/json","Location: http://127.0.0.1:8401/unsafe\r\n"),
    Http(body,503,"application/json","Content-Length: "+std::to_string(body.size())+"\r\n"),
    Http(body,409),Http(body,400),Http(Json{{"error","service_unavailable"}}.dump(),503),
    Http(Json{{"error","source_frame_before_resume"}}.dump(),503),
    Http(Json{{"error","source_ingestion_paused"},{"extra",true}}.dump(),503),
    Http("{\"error\":\"source_ingestion_paused\",\"error\":\"source_ingestion_paused\"}",503),
    Http(std::string(17000,'x'),503),
    "HTTP/1.1 503 fixture\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n"+body}){
   Fixture f;SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);Wire server(reply);
   Check(operation->Submit(yes).result==Receipt::Result::Unknown,"wire_unverified_error_became_rejected");(void)server.Finish();
  }
 }
 {
  Fixture f;SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  Wire server(Http(Json{{"status","not_found"},{"fingerprint",nullptr}}.dump()));
  Check(http.Reconcile(f.candidate,f.source,f.space,operation->ReceiptKey(),operation->ReceiptQuery(),f.Lease(),yes).result==Receipt::Result::Unknown,
    "wire_not_found_faked_rejection");(void)server.Finish();
 }
 for(int failure=0;failure<3;++failure){
  Fixture f;SearchProducerHttp http;auto operation=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
  const auto reply=failure==0?Http(std::string(17000,'x')):failure==1?"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8401/not-allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n":"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\nx";
  Wire server(reply,failure==2);
  Check(operation->Submit(yes).result==Receipt::Result::Unknown,"wire_failure_faked_rejection_or_success");(void)server.Finish();
 }
 {
  Fixture f;auto transport=std::make_shared<Fake>();transport->answer.body=Json{{"stored",true}}.dump();SearchProducerHttp http(transport);
  SearchCoverageRange range{{f.source,f.space.package_id,f.space.model_version,"session",1,false},1000,1100,61000,SearchCoverageRange::State::Pending};
  Check(http.PublishCoverage(range,f.Lease(),yes),"coverage_ack");const auto pending=Json::parse(transport->metadata);
  Check(pending.size()==8&&pending["state"]=="pending"&&!transport->has_image,"coverage_exact_metadata_no_image");
  range.state=SearchCoverageRange::State::Sampled;Check(http.PublishCoverage(range,f.Lease(),yes),"coverage_final_ack");
  Check(Json::parse(transport->metadata)["id"]==pending["id"],"coverage_promotion_same_id");
  const auto calls=transport->calls;range.scope.source.recording_channel_id=f.input;
  Check(!http.PublishCoverage(range,f.Lease(),yes)&&transport->calls==calls,"coverage_scope_fence");
  range.scope.source=f.source;range.to_ms=range.from_ms;Check(!http.PublishCoverage(range,f.Lease(),yes),"coverage_empty_range");
 }
 {
  Fixture f;SearchProducerHttp http;SearchCoverageRange range{{f.source,f.space.package_id,f.space.model_version,"session",1,true},1000,1100,61000,SearchCoverageRange::State::Gap};
  Wire server(Http(Json{{"stored",true}}.dump()));Check(http.PublishCoverage(range,f.Lease(),yes),"wire_coverage_ack");
  const auto wire=server.Finish();const auto body=Json::parse(Body(wire));
  Check(wire.rfind("PUT /v1/coverage/range ",0)==0&&body.size()==8&&body["kind"]=="scene"&&body["state"]=="gap","wire_coverage_fixed_put");
  Check(Body(wire).find(std::string(64,'b'))==std::string::npos,"coverage_body_no_credential");
 }
 for(int invalid=-1;invalid<9;++invalid){
  Fixture f;auto transport=std::make_shared<Fake>();SearchProducerHttp http(transport);
  f.candidate.reason=SearchSamplingPolicy::Reason::ObjectProbe;f.candidate.slot=f.sample->track_slot=2;
  f.candidate.probe_reference_fingerprint=std::string(64,'e');
  f.sample->evidence["appearance"]={{"metric",kSearchAppearanceMetric},{"reference_fingerprint",std::string(64,'e')},
    {"distance",.5},{"threshold",.25},{"threshold_experimental",true}};
  auto& audit=f.sample->evidence["appearance"];
  if(invalid==0)f.sample->evidence.erase("appearance");
  if(invalid==1)audit["distance"]=-.1;
  if(invalid==2)audit["distance"]=2.1;
  if(invalid==3)audit["reference_fingerprint"]=std::string(64,'f');
  if(invalid==4)audit["threshold_experimental"]=false;
  if(invalid==5)audit["metric"]="unverified-score";
  if(invalid==6)audit["extra"]="not-in-contract";
  if(invalid==7)audit["threshold"]=.5;
  if(invalid==8)f.candidate.probe_reference_fingerprint.clear();
  if(invalid<0){
    transport->answer.body=f.Ack().dump();auto op=http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);
    Check(op->Descriptor().size()==2&&op->Submit(yes).result==Receipt::Result::Committed,"audited_probe_write");
    Check(Json::parse(transport->metadata)["slot"]==2,"probe_uses_actual_change_slot");
  }else{Reject([&]{http.Prepare(f.sample,f.source,f.space,f.Lease(),f.candidate);});Check(transport->calls==0,"invalid_probe_audit_wrote");}
 }
 std::cout<<"search producer HTTP: "<<checks<<" software checks passed; fixed loopback fixture only, no DB/BPU/production config\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;} }

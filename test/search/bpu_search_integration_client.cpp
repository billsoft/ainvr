// Manual, finite real-hardware integration fixture. No production configuration
// changes. The supplied single raw frame is repeated; ROI/quality/analytics are
// FORCED TEST METADATA, never a detector/tracker or semantic-accuracy claim.
#include "output/search_execution_port.hpp"
#include "../../search-service/src/model_package.hpp"
#include "../../shared/cpp/config_center_client.hpp"
#include <httplib.h> // Existing AI system ABI, not search-service's HTTP server.
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cmath>
#include <cstdlib>
#include <set>
#include <thread>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
namespace fs=std::filesystem;
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
using namespace ai_service;
using namespace ai_service::output;
using namespace ai_service::config;
namespace {
std::string TestPackage() {
 const auto* value=std::getenv("AINVR_SEARCH_TEST_PACKAGE");
 const std::string id=value?value:"siglip2-base-full-int8";
 if(id!="siglip2-base-full-int8"&&id!="siglip-so400m-i18n-full-int8")throw std::runtime_error("unsupported_test_package");
 return id;
}

constexpr const char* kInput="00000000-0000-4000-8000-000000000001";
constexpr const char* kOutput="00000000-0000-4000-8000-000000000002";
constexpr const char* kProcessor="search-bpu-fixture";
constexpr const char* kInputPath="/live/search-fixture-raw";
constexpr const char* kOutputPath="/live/search-fixture-ai";
const char* Usage(){return "Manual only: --run-hardware --input-nv12 FILE --matrix bt601|bt709 --range limited|full --report test/results/NEW.json [--managed-access-file PRIVATE.json]\n"
 "Software private-file validation only: --validate-managed-access PRIVATE.json\n"
 "Requires AINVR_SEARCH_TEST_MONGO=1 and the isolated parent-managed fixture server on loopback8400.\n"
 "Exactly one 1920x1080 packed NV12 frame is repeated, at most four prepares. Forced ROI is interface testing, not detection/semantic validation.\n"
 "--help performs no file, network, model, SDK or device operation.\n";}
void Require(bool value,const char* reason){if(!value)throw std::runtime_error(reason);}
int64_t WallMs(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
void Deadline(Clock::time_point end){Require(Clock::now()<end,"integration_deadline_exceeded");}
void NewResultPath(const fs::path& path){
 const auto root=fs::canonical(AINVR_SEARCH_PROBE_RESULTS_ROOT),parent=fs::canonical(path.parent_path());
 const auto relative=parent.lexically_relative(root);
 Require(!relative.empty()&&!relative.is_absolute()&&*relative.begin()!=".."&&!fs::exists(path)&&!path.filename().empty(),"integration_report_requires_new_results_path");
}
void WriteNew(const fs::path& path,const uint8_t* data,size_t bytes){
 const int fd=open(path.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
 Require(fd>=0,"integration_output_create_failed");size_t done=0;
 while(done<bytes){const auto n=write(fd,data+done,bytes-done);if(n<=0){close(fd);throw std::runtime_error("integration_output_write_failed");}done+=size_t(n);}
 const bool ok=fsync(fd)==0;close(fd);Require(ok,"integration_output_sync_failed");
}
void WriteJson(const fs::path& path,const Json& json){const auto text=json.dump(2)+"\n";WriteNew(path,reinterpret_cast<const uint8_t*>(text.data()),text.size());}
struct HttpReply{int status=0;std::string body,content_type;};
HttpReply Console(const std::string& method,const std::string& path,const Json& body,Clock::time_point end,size_t maximum=262144,const std::string& console_key=std::string(48,'c')){
 Deadline(end);HttpReply reply;httplib::Client client("127.0.0.1",8400);
 client.set_connection_timeout(1);client.set_read_timeout(5);client.set_write_timeout(2);client.set_follow_location(false);client.set_keep_alive(false);client.set_decompress(false);
 httplib::Request request;request.method=method;request.path=path;request.redirect_count_=0;
 request.headers.emplace("x-service-token",console_key);
 if(method=="POST"){request.headers.emplace("Content-Type","application/json");request.body=body.dump();}
 request.response_handler=[&](const httplib::Response& response){
  reply.status=response.status;reply.content_type=response.get_header_value("Content-Type");
  if(response.get_header_value("Content-Encoding")!=""||Clock::now()>=end)return false;
  const auto length=response.get_header_value("Content-Length");
  if(!length.empty()&&(length.size()>10||!std::all_of(length.begin(),length.end(),[](char c){return c>='0'&&c<='9';})||std::stoull(length)>maximum))return false;
  return true;
 };
 request.content_receiver=[&](const char* data,size_t bytes,uint64_t,uint64_t){
  if(Clock::now()>=end||bytes>maximum-reply.body.size())return false;
  reply.body.append(data,bytes);return true;
 };
 const auto response=client.send(request);Require(bool(response),"integration_console_transport_failed");Deadline(end);return reply;
}
Json ReadJson(const HttpReply& response){
 Require(response.status==200&&response.content_type.find("application/json")==0,"integration_console_status_failed");
 auto json=Json::parse(response.body,[](int depth,Json::parse_event_t,Json&){if(depth>16)throw std::runtime_error("integration_response_too_deep");return true;});
 Require(json.is_object(),"integration_console_invalid_json");return json;
}
Json ManagedAccess(const fs::path& path){
 const auto base=fs::canonical(AINVR_SEARCH_PROBE_RESULTS_ROOT),parent=fs::canonical(path.parent_path());
 const auto relative=parent.lexically_relative(base);
 Require(!relative.empty()&&!relative.is_absolute()&&*relative.begin()!="..","integration_access_results_path_required");
 struct stat before{},after{};
 Require(lstat(path.c_str(),&before)==0&&S_ISREG(before.st_mode)&&before.st_nlink==1&&before.st_uid==geteuid()&&
   !(before.st_mode&077)&&before.st_size>0&&before.st_size<=65536,"integration_access_private_file_required");
 const auto document=ainvr::config::ReadPrivateJson(path.string());
 Require(lstat(path.c_str(),&after)==0&&before.st_dev==after.st_dev&&before.st_ino==after.st_ino&&
   before.st_size==after.st_size&&before.st_mtim.tv_sec==after.st_mtim.tv_sec&&before.st_mtim.tv_nsec==after.st_mtim.tv_nsec&&
   before.st_ctim.tv_sec==after.st_ctim.tv_sec&&before.st_ctim.tv_nsec==after.st_ctim.tv_nsec,"integration_access_changed_during_read");
 Require(document.is_object()&&document.size()==8&&document.at("schema_version")=="ainvr.search.managed_fixture.v1"&&
   document.at("fixture_mode")=="managed-hardware"&&document.at("enabled")==true&&document.at("reason").is_null()&&
   document.at("desired_version").is_number_integer()&&document.at("desired_version").get<int64_t>()>0&&
   document.at("console").at("endpoint")=="http://127.0.0.1:8400","integration_managed_access_not_admitted");
 const auto key=document.at("console").at("api_token").get<std::string>();
 Require(key.size()>=32&&key.size()<=512&&std::all_of(key.begin(),key.end(),[](unsigned char c){return c>32&&c<127;}),"integration_access_console_key_invalid");
 const auto parsed=ParseSearchProducerGrant(document.at("producer"));
 Require(bool(parsed.grant)&&parsed.grant->endpoint=="http://127.0.0.1:8400"&&document.at("revision")==parsed.grant->revision&&
   parsed.grant->package_id==TestPackage()&&parsed.grant->sources.size()==1,"integration_access_grant_invalid");
 const auto source=parsed.grant->sources.find(kProcessor);
 Require(source!=parsed.grant->sources.end()&&source->second.channel_id==kOutput&&source->second.input_stream_id==kInput&&
   source->second.recording_channel_id==kOutput&&source->second.object&&source->second.scene,"integration_access_source_invalid");
 const auto freshness=document.at("producer").at("valid_for_ms").get<int64_t>();
 const auto age=WallMs()-(int64_t(before.st_mtim.tv_sec)*1000+before.st_mtim.tv_nsec/1000000);
 Require(age>=-1000&&age<freshness,"integration_access_expired");
 return document;
}
// Passive inspection only: forwards every call through the real existing AI
// producer transport. No second upload path, fake ACK or copied JPEG buffer.
struct InspectTransport final:SearchProducerHttpTransport {
 std::shared_ptr<SearchProducerHttpTransport> actual=MakeSearchProducerHttpTransport();
 std::map<std::string,std::string> jpeg_sha;
 size_t writes=0,lookups=0;
 SearchProducerHttpResponse Post(const SearchProducerLease& lease,const std::string& path,const std::string& metadata,
     const std::vector<uint8_t>* jpeg,const SearchSamplingCurrent& current)override{
  if(jpeg){const auto document=Json::parse(metadata);const auto& sample=document.contains("sample")?document.at("sample"):document;
   Require(writes<4,"integration_write_bound_exceeded");jpeg_sha[sample.at("id").get<std::string>()]=ainvr::search::SampleSha256(jpeg->data(),jpeg->size());++writes;
  }else{Require(lookups<8,"integration_receipt_bound_exceeded");++lookups;}
  return actual->Post(lease,path,metadata,jpeg,current);
 }
};
struct Fixture {
 std::shared_ptr<SearchProducerGrantAuthority> authority=std::make_shared<SearchProducerGrantAuthority>();
 ParsedSearchProducerGrant parsed;
 std::shared_ptr<ainvr::Nv12Frame> raw=std::make_shared<ainvr::Nv12Frame>();
 FrameResult result;SearchFrameCapture capture;
 std::optional<fs::path> managed_access;std::string console_key=std::string(48,'c');int desired_version=0;
 Fixture(const fs::path& input,bool bt709,bool full_range,std::optional<fs::path> access={}):managed_access(std::move(access)){
  Json document={{"enabled",true},{"reason",nullptr},{"endpoint","http://127.0.0.1:8400"},{"api_token",std::string(48,'p')},
   {"revision",std::string(64,'a')},{"model",{{"package_id",TestPackage()}}},{"valid_for_ms",30000},
   {"limits",{{"producer_queue",1},{"producer_bytes",33554432},{"image_max_bytes",8388608},{"retention_days",1}}},
   {"sampling",{{"mode","all"},{"channel_ids",Json::array()},{"object",true},{"scene",true},{"object_interval_ms",1000},
    {"scene_active_interval_ms",10000},{"scene_static_interval_ms",60000},{"scene_change_min_interval_ms",3000},{"track_slots",8}}},
   {"sources",Json::array({{{"channel_id",kOutput},{"input_stream_id",kInput},{"processor_id",kProcessor},{"recording_channel_id",kOutput},
    {"input_path",kInputPath},{"output_path",kOutputPath},{"object",true},{"scene",true}}})}};
  if(managed_access){const auto current=ManagedAccess(*managed_access);document=current.at("producer");
   console_key=current.at("console").at("api_token").get<std::string>();desired_version=current.at("desired_version").get<int>();}
  parsed=ParseSearchProducerGrant(document);Require(bool(parsed.grant),"integration_grant_rejected");authority->Start();Renew();
  const auto& binding=parsed.grant->sources.at(kProcessor);
  raw->width=1920;raw->height=1080;const size_t bytes=size_t(1920)*1080*3/2;
  std::ifstream file(input,std::ios::binary|std::ios::ate);Require(bool(file)&&file.tellg()==std::streamoff(bytes),"integration_input_not_one_1080p_nv12_frame");
  raw->pixels.resize(bytes);file.seekg(0);Require(bool(file.read(reinterpret_cast<char*>(raw->pixels.data()),bytes)),"integration_input_read_failed");
  // Deliberately different from canonical mapped PTS and capture_sequence.
  raw->pts=77;
  capture.worker_input_url=std::string("rtmp://127.0.0.1")+binding.input_path;capture.worker_output_url=std::string("rtmp://127.0.0.1")+binding.output_path;
  capture.fence={kProcessor,"search-bpu-fixture-session",binding.input_path,binding.output_path,1,1,1,1920,1080,1920,1080,
   SearchFrameGeometryKind::FullFrameAxisScale,true,SearchSourceProjection::RawPlanar};
  capture.bt709=bt709;capture.full_range=full_range;capture.decoder_frame_index=123;capture.original_source_pts_ns=456;
  result.channel_id=kProcessor;result.stream_url=capture.worker_input_url;result.frame_width=1920;result.frame_height=1080;
  Detection d;d.track_id="forced-roi-track";d.label_id=d.class_name="forced-roi-interface-fixture";d.confidence=1;d.bbox={640,270,640,540};
  result.detections.push_back(d);
 }
 void Renew(){
  if(managed_access){try{const auto current=ManagedAccess(*managed_access);
    Require(current.at("revision")==parsed.grant->revision&&current.at("desired_version")==desired_version&&
      current.at("console").at("api_token")==console_key&&current.at("producer").at("api_token")==parsed.grant->api_token,
      "integration_managed_configuration_changed");
   }catch(...){authority->Stop();throw;}}
  Require(authority->Install(parsed,Clock::now()),"integration_grant_install_failed");
 }
 SearchProducerLease Lease(){Renew();auto lease=authority->Read();Require(bool(lease),"integration_grant_expired");return *lease;}
 SearchSamplingFrame Advance(int index){
  capture.mapped_pts_ns=result.frame_pts_ns=int64_t(index)*1000000000;capture.capture_sequence=result.frame_index=index;capture.captured_wall=double(WallMs())/1000;
  result.model_extra["analytics"]={{"status","active"},{"stream_session_id",capture.fence.stream_session_id},{"view_reset_epoch",1},
   {"tracks",Json::array({{{"track_id","forced-roi-track"},{"state","confirmed"},{"observation","detected"},{"last_observed_pts_ns",std::to_string(result.frame_pts_ns)}}})}};
  auto frame=SearchSamplingPolicy::FrameFromResult(result,kInput,int64_t(static_cast<long double>(capture.captured_wall)*1000));
  Require(bool(frame),"integration_frame_contract_failed");return *frame;
 }
};
}
int main(int argc,char** argv){
 try{
  if(argc==2&&std::string(argv[1])=="--help"){std::cout<<Usage();return 0;}
  if(argc==3&&std::string(argv[1])=="--validate-managed-access"){
   const auto value=ManagedAccess(argv[2]);std::cout<<Json({{"private_access_valid",true},{"hardware_executed",false},{"desired_version",value.at("desired_version")}}).dump()<<'\n';return 0;}
  if(argc<2||std::string(argv[1])!="--run-hardware"){std::cerr<<Usage();return 64;}
  Require(std::getenv("AINVR_SEARCH_TEST_MONGO")&&std::string(std::getenv("AINVR_SEARCH_TEST_MONGO"))=="1","integration_explicit_test_environment_required");
  std::map<std::string,std::string> args;
  for(int n=2;n<argc;n+=2){Require(n+1<argc&&args.emplace(argv[n],argv[n+1]).second,"integration_invalid_arguments");}
  Require((args.size()==4||(args.size()==5&&args.contains("--managed-access-file")))&&args.contains("--input-nv12")&&args.contains("--report")&&args.contains("--matrix")&&args.contains("--range"),"integration_invalid_arguments");
  Require((args.at("--matrix")=="bt601"||args.at("--matrix")=="bt709")&&(args.at("--range")=="limited"||args.at("--range")=="full"),"integration_invalid_color_contract");
  const fs::path report=args.at("--report");NewResultPath(report);
  const auto images=report.parent_path()/(report.stem().string()+"-images");Require(fs::create_directory(images),"integration_image_directory_must_be_new");
  const auto start=Clock::now(),end=start+std::chrono::seconds(120);
  std::optional<fs::path> managed_access;if(args.contains("--managed-access-file"))managed_access=args.at("--managed-access-file");
  Fixture fixture(args.at("--input-nv12"),args.at("--matrix")=="bt709",args.at("--range")=="full",managed_access);
  const auto initial=ReadJson(Console("GET","/v1/status",{},end,262144,fixture.console_key));
  Require(initial.value("ready",false),"integration_fixture_server_not_ready");
  auto hardware=MakeNativeSearchHardwareOwner();auto transport=std::make_shared<InspectTransport>();
  auto port=MakeSearchExecutionPort(hardware,std::make_shared<SearchProducerHttp>(transport));
  while(!hardware->CurrentSpace()){Deadline(end);const auto state=hardware->Refresh(fixture.Lease());
   Require(state!=SearchHardwareOwner::State::Failed&&state!=SearchHardwareOwner::State::Stopped,"integration_hardware_load_failed");
   std::this_thread::sleep_for(std::chrono::milliseconds(10));}
  const auto space=*hardware->CurrentSpace();Require(initial.at("model_version")==space.model_version,"integration_text_vision_model_mismatch");
  SearchSamplingPolicy policy;SearchWorkBudget budget;budget.Configure(1,33554432);
  std::map<std::string,Json> current_samples;Json uploads=Json::array();std::string replaced_fingerprint,best_id;
  auto execute=[&](const SearchSamplingPolicy::Candidate& candidate){
   Deadline(end);auto lease=fixture.Lease();hardware->Refresh(lease);
   auto ticket=budget.TryAcquire(fixture.raw->pixels.capacity()+8388608+65536);Require(bool(ticket),"integration_frame_budget_rejected");
   auto frozen=FreezeSearchFrame(lease,candidate,fixture.result,fixture.capture,fixture.capture.fence,fixture.raw,std::move(*ticket));
   Require(bool(frozen),"integration_freeze_failed");
   const auto began=Clock::now();auto current=[&]{return Clock::now()<end&&lease.IsCurrent()&&bool(hardware->CurrentSpace())&&frozen.frame->IsCurrent(fixture.capture.fence);};
   auto operation=port->Prepare(*frozen.frame,space,lease,current);Require(bool(operation),"integration_prepare_failed");
   const auto query=Json::parse(operation->ReceiptQuery());const auto metadata=query.at("sample");const auto id=metadata.at("id").get<std::string>();
   auto receipt=operation->Submit(current);
   if(receipt.result==SearchSamplingReceipt::Result::Unknown)
    receipt=port->Reconcile(candidate,frozen.frame->Source(),space,operation->ReceiptKey(),operation->ReceiptQuery(),fixture.Lease(),current);
   Require(receipt.result==SearchSamplingReceipt::Result::Committed&&receipt.fingerprint==query.at("request_fingerprint"),"integration_storage_ack_missing_or_mismatched");
   Require(policy.Resolve(candidate.token,SearchSamplingPolicy::Outcome::Committed,receipt.fingerprint),"integration_policy_commit_failed");
   const auto lookup=port->Reconcile(candidate,frozen.frame->Source(),space,operation->ReceiptKey(),operation->ReceiptQuery(),fixture.Lease(),current);
   Require(lookup.result==SearchSamplingReceipt::Result::Committed&&lookup.fingerprint==receipt.fingerprint,"integration_receipt_lookup_failed");
   auto expected=metadata;expected["fingerprint"]=receipt.fingerprint;current_samples[id]=expected;
   uploads.push_back({{"id",id},{"kind",metadata.at("kind")},{"slot",candidate.slot?Json(*candidate.slot):Json(nullptr)},
    {"fingerprint",receipt.fingerprint},{"frame_id",metadata.at("evidence").at("frame_id")},
    {"prepare_store_ms",std::chrono::duration<double,std::milli>(Clock::now()-began).count()}});
   operation.reset();frozen.frame.reset();Require(budget.Inspect().jobs==0,"integration_frame_budget_leaked");Deadline(end);return id;
  };
  auto frame=fixture.Advance(1);Require(policy.BindSource(frame.binding),"integration_policy_bind_failed");
  auto proposal=policy.ProposeScene(frame,{true,true,{}});Require(bool(proposal.candidate),"integration_scene_not_due");execute(*proposal.candidate);
  for(int n=2;n<=4;++n){frame=fixture.Advance(n);auto observation=SearchSamplingPolicy::ObjectFromResult(fixture.result,"forced-roi-track",true,double(n)/5);
   Require(bool(observation),"integration_forced_roi_not_eligible");proposal=policy.ProposeObject(frame,*observation);Require(bool(proposal.candidate),"integration_object_not_due");
   if(n==4){Require(proposal.candidate->slot==1&&!proposal.candidate->expected_fingerprint.empty(),"integration_replacement_not_cas");replaced_fingerprint=proposal.candidate->expected_fingerprint;}
   const auto id=execute(*proposal.candidate);if(n==3)best_id=id;if(n==4)Require(id==best_id,"integration_replacement_created_extra_slot_document");}
  Require(current_samples.size()==3&&transport->writes==4,"integration_sample_bound_mismatch");
  Json samples=Json::array();std::set<std::string> allowed_fingerprints;int64_t from=INT64_MAX,to=0;
  for(const auto& [id,expected]:current_samples){
   const auto path="/v1/samples/"+id+"?channel_id="+kOutput+"&model_version="+space.model_version;
   const auto actual=ReadJson(Console("GET",path,{},end,262144,fixture.console_key));Require(actual==expected,"integration_stored_metadata_mismatch");
   const auto& evidence=actual.at("evidence");Require(actual.at("processor_id")==kProcessor&&actual.at("channel_id")==kOutput&&
    evidence.at("source_input_id")==kInput&&evidence.at("recording_channel_id")==kOutput&&evidence.at("output_channel_id")==kOutput&&
    evidence.at("stream_session_id")==fixture.capture.fence.stream_session_id&&evidence.at("frame_width")==1920&&evidence.at("frame_height")==1080&&
    evidence.at("raw_frame_width")==1920&&evidence.at("raw_frame_height")==1080&&evidence.at("projection_mode")=="raw_planar", "integration_source_or_frame_binding_mismatch");
   const auto image=Console("GET","/v1/samples/"+id+"/image?channel_id="+kOutput+"&model_version="+space.model_version,{},end,8388608,fixture.console_key);
   Require(image.status==200&&image.content_type=="image/jpeg"&&image.body.size()>4,"integration_image_unavailable");
   const auto image_sha=ainvr::search::SampleSha256(reinterpret_cast<const uint8_t*>(image.body.data()),image.body.size());
   Require(transport->jpeg_sha.at(id)==image_sha,"integration_image_different_from_prepared_upload");
   WriteNew(images/(id+".jpg"),reinterpret_cast<const uint8_t*>(image.body.data()),image.body.size());
   const auto captured=actual.at("captured_ms").get<int64_t>();from=std::min(from,captured);to=std::max(to,captured);
   const auto fp=actual.at("fingerprint").get<std::string>();Require(fp!=replaced_fingerprint,"integration_old_slot_fingerprint_visible");allowed_fingerprints.insert(fp);
   samples.push_back({{"id",id},{"fingerprint",fp},{"jpeg_sha256",image_sha},{"jpeg_bytes",image.body.size()},{"metadata",actual}});
  }
  Json matches=Json::array();
  for(const auto& text:{std::string("监控画面中的物体和场景"),std::string("objects and scene in a video camera frame")}){
   const auto began=Clock::now();auto response=ReadJson(Console("POST","/v1/match",{{"query",text},{"scope",{{"channel_ids",Json::array({kOutput})},{"from_ms",from-1000},{"to_ms",to+60000},{"limit",20}}}},end,262144,fixture.console_key));
   Require(response.at("model_version")==space.model_version&&response.at("partial").get<bool>()==bool(managed_access)&&response.at("items").is_array()&&!response.at("items").empty(),"integration_match_not_ready_or_empty");
   for(const auto& item:response.at("items")){
    const auto id=item.at("id").get<std::string>();Require(current_samples.contains(id)&&allowed_fingerprints.contains(item.at("fingerprint").get<std::string>())&&
     item.at("evidence")==current_samples.at(id).at("evidence")&&std::isfinite(item.at("similarity").get<double>()),"integration_match_stale_score_or_wrong_evidence");}
   matches.push_back({{"query",text},{"elapsed_ms",std::chrono::duration<double,std::milli>(Clock::now()-began).count()},{"response",response}});
  }
  hardware->Stop();fixture.authority->Stop();Require(!hardware->CurrentSpace(),"integration_shutdown_still_ready");Deadline(end);
  Json result={{"interface_passed",true},{"forced_roi",true},{"forced_quality_metadata",true},{"semantic_accuracy_verified",false},{"detector_accuracy_verified",false},
   {"managed_configuration",bool(managed_access)},{"managed_desired_version",fixture.desired_version},
   {"same_raw_input_repeated",true},{"cpu_inference",false},{"cpu_image_processing",false},{"model_version",space.model_version},{"input_spec_version",space.input_spec_version},
   {"uploads",uploads},{"current_documents",samples},{"match_queries",matches},{"image_directory",images.string()},
   {"writes",transport->writes},{"receipt_lookups",transport->lookups},{"elapsed_ms",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}};
  WriteJson(report,result);std::cout<<Json({{"interface_passed",true},{"forced_roi",true},{"semantic_accuracy_verified",false},{"report",report.string()}}).dump()<<'\n';return 0;
 }catch(const std::exception& error){
  const std::string message=error.what();
  std::cerr<<(message.rfind("integration_",0)==0?message:"integration_hardware_or_runtime_failed")<<'\n';return 1;
 }
}

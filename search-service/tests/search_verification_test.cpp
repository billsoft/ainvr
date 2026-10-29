#include "http_service.hpp"
#include <mongoc/mongoc.h>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json=nlohmann::json;
int checks=0;
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
void Check(bool condition,int line=__builtin_LINE()){++checks;if(!condition)throw std::runtime_error("verification_test_line_"+std::to_string(line));}
template<class F> void Reject(F run){bool rejected=false;try{run();}catch(...){rejected=true;}Check(rejected);}
std::string Id(int n){return "00000000-0000-4000-8000-"+std::to_string(100000000000LL+n);}
std::string Hash(const std::string& value){return SampleSha256(reinterpret_cast<const uint8_t*>(value.data()),value.size());}
const auto channel=Id(1);
Json Profile(char model='a'){
  Json value{{"task_id","search-verify-zh-v1"},{"template_sha256",std::string(64,'b')},
    {"preprocessing_version","jpeg420-vpu-gles-rgb-letterbox896x448-v1"},{"decision_policy","abc-visible-v1"},
    {"model_package_id","qwen3vl-4b-review-v3"},{"model_package_sha256",std::string(64,model)}};
  value["profile_fp"]=Hash(Json::array({value["task_id"],value["template_sha256"],value["preprocessing_version"],
    value["decision_policy"],value["model_package_id"],value["model_package_sha256"]}).dump());return value;
}
Sample Make(int n,int64_t at){return {{Id(n),channel,"processor","session","track-"+std::to_string(n),"pair-v1",at,false,{1,0}},
  {{"role","match"},{"source_input_id",channel},{"output_channel_id",channel},{"recording_channel_id",channel},
   {"schema_version","1.0"},{"stream_session_id","session"},{"source_pts_ns",std::to_string(at*1000000LL)},
   {"source_frame_index",std::to_string(n)},{"frame_id",Id(n)},{"frame_width",1920},{"frame_height",1080}},
  {255,216,255,217},at+60000};}
void Command(mongoc_client_t* client,const std::string& db,const nlohmann::ordered_json& command){
  const auto text=command.dump();bson_error_t error{};bson_t reply;auto* input=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error);
  Check(input!=nullptr);const bool ok=mongoc_client_command_simple(client,db.c_str(),input,nullptr,&reply,&error);bson_destroy(input);bson_destroy(&reply);Check(ok);
}
Json Open(HistoryMongo& history,int id,const std::vector<int>& samples,const std::string& actor="operator",const std::string& query="a red bag",bool wider_scope=false){
  const auto at=Now()-2000;SearchSessionRequest request{Id(id),actor,query,"pair-v1",{{channel},at-10000,at+10000,60},true,Now()+3600000};
  if(wider_scope){request.scope.channels.insert(Id(2));request.scope.from_ms-=5000;request.scope.to_ms+=5000;}
  const auto version=history.BeginSearch(request);std::vector<SearchSessionCandidate> candidates;double score=1;
  for(auto n:samples){auto sample=history.Get(Id(n),false);candidates.push_back({Id(n),score,sample?sample->fingerprint:std::string{}});score-=.01;}
  Check(history.PublishSearch(request.id,actor,version,candidates,"partial"));
  return {{"search_id",request.id},{"actor",actor},{"version",version},{"sample_id",Id(samples.front())}};
}
Json Inspect(HistoryMongo& history,const Json& target,const Json& profile,const char* scope="visible"){
  return history.SearchVerification({{"action","inspect"},{"target",target},{"profile",profile},{"question_scope",scope}});
}
Json Queue(HistoryMongo& history,const Json& binding,const Json& profile,int job,int gen=0){
  return history.SearchVerification({{"action","queued"},{"binding",binding},{"profile",profile},{"job_id",Id(job)},{"generation",gen}});
}
Json Begin(HistoryMongo& history,const Json& binding,int job,int gen,const std::string& request){
  return history.SearchVerification({{"action","begin"},{"binding",binding},{"job_id",Id(job)},{"generation",gen},{"request_id",request}});
}
Json Result(const Json& binding,const Json& profile,const std::string& request,const std::string& query="a red bag",const char* decision="match"){
  Json value{{"schema","ainvr.search_verification.v1"},{"request_id",request},{"frame_id",binding["frame_id"]},{"evidence_sha256",binding["jpeg_sha256"]},
    {"query_sha256",binding["query_sha256"]},{"question_scope",binding["question_scope"]},{"kind","object"},{"template",profile["task_id"]},
    {"template_sha256",profile["template_sha256"]},{"preprocessing_version",profile["preprocessing_version"]},{"decision_policy",profile["decision_policy"]},
    {"model",{{"package_id",profile["model_package_id"]},{"package_sha256",profile["model_package_sha256"]}}},{"validated",false},
    {"score_kind","three_way_softmax_uncalibrated"},{"decision",decision},{"reason","visible_evidence"},
    {"logits",{{"A",3},{"B",0},{"C",0}}},{"reference_scores",{{"A",.9},{"B",.05},{"C",.05}}},{"timing_ms",{{"queue",0},{"preprocess",1},{"total",2}}}};
  if(binding.at("question_scope")=="temporal")value.update({{"decision","uncertain"},{"reason","temporal_evidence_required"},{"logits",nullptr},{"reference_scores",nullptr}});
  value["input_sha256"]=Hash(Json{{"query",query},{"question_scope",binding["question_scope"]},{"kind","object"},{"frame_id",binding["frame_id"]},
    {"evidence_sha256",binding["jpeg_sha256"]},{"template_sha256",profile["template_sha256"]},{"preprocessing_version",profile["preprocessing_version"]},
    {"model_sha256",profile["model_package_sha256"]}}.dump());return value;
}
Json Finish(HistoryMongo& history,const Json& binding,int job,int gen,const std::string& request,const Json& result){
  return history.SearchVerification({{"action","finish"},{"binding",binding},{"job_id",Id(job)},{"generation",gen},{"request_id",request},{"result",result}});
}
Json Abort(HistoryMongo& history,const Json& binding,int job,int gen,const Json& request,const char* reason="already_submitted"){
  return history.SearchVerification({{"action","abort"},{"binding",binding},{"job_id",Id(job)},{"generation",gen},{"request_id",request},{"reason",reason}});
}
size_t CacheLimits(mongoc_client_t* client,const std::string& db,int64_t max_expiry,size_t maximum){
  auto* collection=mongoc_client_get_collection(client,db.c_str(),"search_verification_cache");bson_t filter=BSON_INITIALIZER;
  auto* cursor=mongoc_collection_find_with_opts(collection,&filter,nullptr,nullptr);const bson_t* doc=nullptr;size_t count=0;
  while(mongoc_cursor_next(cursor,&doc)){++count;Check(doc->len<=8192);bson_iter_t expiry;
    Check(bson_iter_init_find(&expiry,doc,"expires_at")&&BSON_ITER_HOLDS_DATE_TIME(&expiry)&&bson_iter_date_time(&expiry)<=max_expiry&&bson_iter_date_time(&expiry)<=Now()+3600000);
    Check(!bson_has_field(doc,"jpeg")&&!bson_has_field(doc,"vector")&&!bson_has_field(doc,"query"));
  }
  Check(count<=maximum);mongoc_cursor_destroy(cursor);bson_destroy(&filter);mongoc_collection_destroy(collection);return count;
}
int64_t SessionExpiry(mongoc_client_t* client,const std::string& db,const std::string& version){
  auto* collection=mongoc_client_get_collection(client,db.c_str(),"search_sessions");bson_t filter=BSON_INITIALIZER;BSON_APPEND_UTF8(&filter,"version",version.c_str());
  auto* cursor=mongoc_collection_find_with_opts(collection,&filter,nullptr,nullptr);const bson_t* doc=nullptr;Check(mongoc_cursor_next(cursor,&doc));bson_iter_t value;
  Check(bson_iter_init_find(&value,doc,"expires_at")&&BSON_ITER_HOLDS_DATE_TIME(&value));const auto expiry=bson_iter_date_time(&value);
  mongoc_cursor_destroy(cursor);bson_destroy(&filter);mongoc_collection_destroy(collection);return expiry;
}
void ScanIndexOrder(mongoc_client_t* client,const std::string& db){
  auto* collection=mongoc_client_get_collection(client,db.c_str(),"search_sessions");auto* cursor=mongoc_collection_find_indexes_with_opts(collection,nullptr);
  const bson_t* doc=nullptr;bool found=false;
  while(mongoc_cursor_next(cursor,&doc)){
    bson_iter_t name;if(!bson_iter_init_find(&name,doc,"name")||!BSON_ITER_HOLDS_UTF8(&name)||std::string(bson_iter_utf8(&name,nullptr))!="search_verification_scan")continue;
    bson_iter_t keys,ordered;Check(bson_iter_init_find(&keys,doc,"key")&&bson_iter_recurse(&keys,&ordered));
    Check(bson_iter_next(&ordered)&&std::string(bson_iter_key(&ordered))=="created_ms");
    Check(bson_iter_next(&ordered)&&std::string(bson_iter_key(&ordered))=="_id");Check(!bson_iter_next(&ordered));found=true;
  }
  Check(found);mongoc_cursor_destroy(cursor);mongoc_collection_destroy(collection);
}
void MainCases(HistoryMongo& history,mongoc_client_t* client,const std::string& db,const std::string& uri){
  ScanIndexOrder(client,db);
  const auto profile=Profile();Check(profile.at("profile_fp")=="b094daef37bb4f3234405177c1f25a0a447a1ff5fb56b00d95e8853772cc4199");
  const auto at=Now()-1000;for(int n=10;n<18;++n)history.Put(Make(n,at+n));
  auto target=Open(history,100,{15,10,14,11,13,12});const auto inspect=Inspect(history,target,profile),binding=inspect.at("binding");
  Check(inspect.at("status")=="pending"&&inspect.at("query")=="a red bag");
  Check(binding.at("query_sha256")==Hash("a red bag")&&binding.at("jpeg_sha256")==Hash(std::string("\xff\xd8\xff\xd9",4)));
  auto sixth=target;sixth["sample_id"]=Id(12);Check(Inspect(history,sixth,profile).at("status")=="unavailable");
  auto invalid_profile=profile;invalid_profile["template_sha256"]=std::string(64,'c');Reject([&]{Inspect(history,target,invalid_profile);});
  auto injected=Json{{"action","inspect"},{"target",target},{"profile",profile},{"question_scope","visible"},{"url","http://camera"}};
  Reject([&]{history.SearchVerification(injected);});
  Check(Queue(history,binding,profile,500).at("status")=="queued");
  auto page=history.ReadSearch(target["search_id"],"operator");Check(page&&page->items[0].verification&&page->items[0].verification->at("state")=="queued");
  Reject([&]{Begin(history,binding,500,0,"attempt-1");});
  Check(Begin(history,binding,500,1,"attempt-1").at("status")=="submit");
  const auto again=Begin(history,binding,500,2,"must-not-submit");Check(again.at("status")=="already_submitted"&&again.at("submitted").at("request_id")=="attempt-1");
  Check(Queue(history,binding,profile,500,2).at("status")=="already_submitted");
  const auto result=Result(binding,profile,"attempt-1");
  Check(!Finish(history,binding,500,2,"attempt-1",result).at("stored").get<bool>());
  for(const auto* field:{"actor","version","sample_id","frame_id","fingerprint","query_sha256","jpeg_sha256","profile_fp"}){
    auto bad=binding;
    if(std::string(field)=="actor")bad[field]="someone-else";
    else if(std::string(field)=="sample_id"||std::string(field)=="frame_id")bad[field]=Id(17);
    else bad[field]=std::string(64,'d');
    Check(!Finish(history,bad,500,1,"attempt-1",result).at("stored").get<bool>());
  }
  for(const auto* field:{"query_sha256","evidence_sha256","input_sha256","template_sha256"}){
    auto bad=result;bad[field]=std::string(64,'d');Reject([&]{Finish(history,binding,500,1,"attempt-1",bad);});
  }
  auto bad_result=result;bad_result["jpeg_base64"]="hidden";Reject([&]{Finish(history,binding,500,1,"attempt-1",bad_result);});
  Check(Finish(history,binding,500,1,"attempt-1",result).at("stored")==true);
  Check(Finish(history,binding,500,1,"attempt-1",result).at("stored")==true);
  Check(Finish(history,binding,500,1,"attempt-1",Result(binding,profile,"attempt-1","a red bag","mismatch")).at("stored")==false);
  Check(history.SearchFeedback(target["search_id"],"operator",target["sample_id"],false));
  auto final=history.ReadSearch(target["search_id"],"operator");Check(final&&final->items[0].relevant==false&&final->items[0].verification->at("state")=="match");
  // Exact cross-session reuse is read-only until an explicit queue/adopt write;
  // the original model request is retained rather than invented afresh.
  auto cached_target=Open(history,101,{15},"operator","a red bag",true);auto cached=Inspect(history,cached_target,profile);
  Check(cached.at("scope").at("channel_ids").size()==2&&cached.at("scope")!=inspect.at("scope"));
  Check(cached.at("status")=="cached"&&cached.at("verification").at("request_id")=="attempt-1");
  Check(!history.ReadSearch(cached_target["search_id"],"operator")->items[0].verification);
  auto adopted=Queue(history,cached["binding"],profile,501);Check(adopted.at("status")=="final"&&adopted.at("verification").at("cached")==true);
  auto other=Open(history,102,{15},"other-operator");Check(Inspect(history,other,profile).at("status")=="pending");
  auto different=Open(history,103,{15},"operator","a blue bag");Check(Inspect(history,different,profile).at("status")=="pending");
  Check(Inspect(history,cached_target,profile,"temporal").at("status")=="pending");
  // A cache entry cannot resurrect a cancelled/expired ownership proof.
  history.CancelSearch(cached_target["search_id"],"operator");
  Check(Inspect(history,cached_target,profile).at("status")=="cancelled");
  Check(!history.ReadSearch(cached_target["search_id"],"operator"));
  Check(!history.SearchImage(cached_target["search_id"],"operator",Id(15),Id(15)));
  Check(!Queue(history,cached["binding"],profile,501).at("stored").get<bool>());

  auto second=target;second["sample_id"]=Id(10);auto old_binding=Inspect(history,second,profile).at("binding");
  Queue(history,old_binding,profile,502);Begin(history,old_binding,502,1,"unknown-old");
  const auto next_profile=Profile('c');const auto superseded=Inspect(history,target,next_profile);
  Check(superseded.at("status")=="profile_superseded"&&superseded.at("binding")==old_binding&&superseded.at("submitted").at("request_id")=="unknown-old");
  Check(Queue(history,superseded["binding"],profile,502,2).at("status")=="already_submitted");
  Check(Abort(history,old_binding,502,2,"unknown-old","profile_changed").at("stored")==true);
  auto next=Inspect(history,target,next_profile);Check(next.at("status")=="pending");
  Check(Queue(history,next["binding"],next_profile,503).at("status")=="queued");
  Check(Finish(history,old_binding,502,1,"unknown-old",Result(old_binding,profile,"unknown-old")).at("stored")==false);
  Begin(history,next["binding"],503,1,"new-profile");
  Check(Finish(history,next["binding"],503,1,"new-profile",Result(next["binding"],next_profile,"new-profile")).at("stored")==true);
  // Submitted cleanup remains possible after the evidence lifetime ends, but
  // confirmation/cache publication is refused for the old image.
  auto expiring=Open(history,104,{16});auto exp_binding=Inspect(history,expiring,profile).at("binding");Queue(history,exp_binding,profile,504);Begin(history,exp_binding,504,1,"expired-image");
  Command(client,db,{{"update","search_samples"},{"updates",Json::array({{{"q",{{"_id",Id(16)}}},{"u",{{"$set",{{"expires_at",{{"$date",{{"$numberLong",std::to_string(Now()-1)}}}}}}}}}}})}});
  Check(!Finish(history,exp_binding,504,1,"expired-image",Result(exp_binding,profile,"expired-image")).at("stored").get<bool>());
  Check(Inspect(history,expiring,next_profile).at("status")=="profile_superseded");
  const auto expired_proof=Inspect(history,expiring,profile);
  Check(expired_proof.at("status")=="submitted"&&expired_proof.at("binding")==exp_binding&&expired_proof.at("submitted").at("request_id")=="expired-image");
  Check(expired_proof.at("query").is_null()&&expired_proof.at("kind").is_null()&&expired_proof.at("scope").is_null()&&expired_proof.at("expires_ms").is_null());
  auto other_actor=expiring;other_actor["actor"]="another-operator";
  Check(Inspect(history,other_actor,profile).at("binding").is_null());

  Check(Abort(history,exp_binding,504,2,"expired-image","evidence_unavailable").at("stored")==true);
  auto cancelled=Open(history,105,{17});auto cancel_binding=Inspect(history,cancelled,profile).at("binding");Queue(history,cancel_binding,profile,505);Begin(history,cancel_binding,505,1,"cancelled-search");
  const auto original_expiry=SessionExpiry(client,db,cancelled["version"]);
  history.CancelSearch(cancelled["search_id"],"operator");history.CancelSearch(cancelled["search_id"],"operator");
  Check(!Finish(history,cancel_binding,505,1,"cancelled-search",Result(cancel_binding,profile,"cancelled-search")).at("stored").get<bool>());
  Check(!history.ReadSearch(cancelled["search_id"],"operator")&&!history.SearchImage(cancelled["search_id"],"operator",Id(17),Id(17)));
  {
    HistoryMongo restarted(uri,db);restarted.Initialize();
    const auto recalled=Inspect(restarted,cancelled,profile);
    Check(recalled.at("status")=="cancelled"&&recalled.at("binding")==cancel_binding&&recalled.at("submitted").at("request_id")=="cancelled-search");
    Check(recalled.at("query").is_null()&&recalled.at("kind").is_null()&&recalled.at("scope").is_null());
    // A cancelled PG job need not be claimable: bounded discovery still yields
    // a cancellation-only reference, never a new model-verification candidate.
    const auto cleanup_page=restarted.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
    Check(cleanup_page.at("refs").empty()&&cleanup_page.at("cleanup_refs").size()==1&&cleanup_page.at("cleanup_refs")[0]==cancelled);
    Check(Abort(restarted,cancel_binding,505,2,"cancelled-search","cancelled").at("stored")==true);
    Check(Abort(restarted,cancel_binding,505,2,"cancelled-search","cancelled").at("stored")==true);
    const auto cleared=Inspect(restarted,cancelled,profile);Check(cleared.at("status")=="cancelled"&&cleared.at("submitted").is_null());
    Check(!restarted.ReadSearch(cancelled["search_id"],"operator"));
  }
  Check(SessionExpiry(client,db,cancelled["version"])==original_expiry);
  CacheLimits(client,db,at+60017,5000);
  // The same stable slot id can acquire a newer frame/JPEG. Both old cache and
  // old in-flight writes must remain bound to the retired fingerprint/frame.
  auto slot=Make(80,Now()-1000);const auto fp=history.ReplaceTrackSlot(slot,0,"","first-slot");
  auto slot_target=Open(history,106,{80});const auto old_slot=Inspect(history,slot_target,profile).at("binding");
  Queue(history,old_slot,profile,580);Begin(history,old_slot,580,1,"slot-original");
  const auto old_result=Result(old_slot,profile,"slot-original");Check(Finish(history,old_slot,580,1,"slot-original",old_result).at("stored")==true);
  auto replacement=slot;replacement.record.captured_ms+=10;replacement.evidence["source_pts_ns"]=std::to_string(replacement.record.captured_ms*1000000LL);
  replacement.evidence["source_frame_index"]="81";replacement.evidence["frame_id"]=Id(81);
  const auto newer=history.ReplaceTrackSlot(replacement,0,fp,"second-slot");Check(newer!=fp);
  Check(Finish(history,old_slot,580,1,"slot-original",old_result).at("stored")==false);
  Check(history.ReadSearch(slot_target["search_id"],"operator")->items.empty());
  const auto retired_proof=Inspect(history,slot_target,profile);
  // This request already finished: the retired image must not expose a cache
  // result or invent an outstanding submission to cancel.
  Check(retired_proof.at("status")=="unavailable"&&retired_proof.at("binding").is_null()&&retired_proof.at("submitted").is_null());

  auto new_slot_target=Open(history,107,{80});const auto new_slot=Inspect(history,new_slot_target,profile);
  Check(new_slot.at("status")=="pending"&&new_slot.at("binding").at("frame_id")==Id(81)&&new_slot.at("binding").at("fingerprint")==newer);
  Check(new_slot.at("binding").at("jpeg_sha256")==old_slot.at("jpeg_sha256")); // Matching image bytes alone cannot reuse a retired slot.
  // A separate request really is in flight when its slot is replaced. Only
  // its exact submitted proof survives; no retired JPEG/query may be recalled.
  auto inflight_slot=Make(82,Now()-1000);const auto inflight_fp=history.ReplaceTrackSlot(inflight_slot,0,"","inflight-first");
  auto inflight_target=Open(history,109,{82});const auto inflight_binding=Inspect(history,inflight_target,profile).at("binding");
  Queue(history,inflight_binding,profile,582);Begin(history,inflight_binding,582,1,"inflight-original");
  auto inflight_replacement=inflight_slot;inflight_replacement.record.captured_ms+=10;
  inflight_replacement.evidence["source_pts_ns"]=std::to_string(inflight_replacement.record.captured_ms*1000000LL);
  inflight_replacement.evidence["source_frame_index"]="83";inflight_replacement.evidence["frame_id"]=Id(83);
  Check(history.ReplaceTrackSlot(inflight_replacement,0,inflight_fp,"inflight-second")!=inflight_fp);
  const auto inflight_proof=Inspect(history,inflight_target,profile);
  Check(inflight_proof.at("status")=="submitted"&&inflight_proof.at("binding")==inflight_binding&&inflight_proof.at("submitted").at("request_id")=="inflight-original");
  Check(inflight_proof.at("query").is_null()&&inflight_proof.at("kind").is_null()&&inflight_proof.at("scope").is_null()&&inflight_proof.at("expires_ms").is_null());
  Check(!history.SearchImage(inflight_target["search_id"],"operator",Id(82),Id(82)));
  history.CancelSearch(inflight_target["search_id"],"operator");
  const auto cancelled_inflight=Inspect(history,inflight_target,profile);
  Check(cancelled_inflight.at("status")=="cancelled"&&cancelled_inflight.at("binding")==inflight_binding&&cancelled_inflight.at("submitted").at("request_id")=="inflight-original");
  Check(Abort(history,inflight_binding,582,2,"inflight-original","cancelled").at("stored")==true);
  Check(Inspect(history,inflight_target,profile).at("submitted").is_null());
  Check(!history.ReadSearch(inflight_target["search_id"],"operator"));
  const Json expired_date{{"$date",{{"$numberLong",std::to_string(Now()-1)}}}};
  const Json expiration{{"q",{{"profile_fp",profile["profile_fp"]}}},{"u",{{"$set",{{"expires_at",expired_date}}}}},{"multi",true}};
  Command(client,db,{{"update","search_verification_cache"},{"updates",Json::array({expiration})}});
  auto uncached=Open(history,108,{15});Check(Inspect(history,uncached,profile).at("status")=="pending");
}
void ScanCases(HistoryMongo& history,mongoc_client_t* client,const std::string& db){
  const auto at=Now()-1000;for(int n=20;n<23;++n)history.Put(Make(n,at));
  auto oldest=Open(history,220,{20}),newest=Open(history,221,{21}),legacy=Open(history,222,{22});
  Command(client,db,{{"update","search_sessions"},{"updates",Json::array({
    {{"q",{{"version",oldest["version"]}}},{"u",{{"$set",{{"created_ms",10}}}}}},
    {{"q",{{"version",newest["version"]}}},{"u",{{"$set",{{"created_ms",20}}}}}},
    {{"q",{{"version",legacy["version"]}}},{"u",{{"$unset",{{"created_ms",""}}}}}}
  })}});
  const auto profile=Profile();auto first=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
  Check(first.at("refs").size()==1&&first.at("refs")[0]==newest&&first.at("next_cursor").at("created_ms")==20);
  auto second=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",first["next_cursor"]}});
  Check(second.at("refs").size()==1&&second.at("refs")[0]==oldest);
  auto end=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",second["next_cursor"]}});
  Check(end.at("refs").empty()&&end.at("next_cursor").is_null());Check(bool(history.ReadSearch(legacy["search_id"],"operator")));
  const auto binding=Inspect(history,newest,profile).at("binding");Queue(history,binding,profile,520);
  auto pending=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
  Check(pending.at("refs")[0]==oldest); // An already queued top slot is not re-enqueued.
  // The browser query remains open after a PG timeout. Lost cancel/abort
  // responses must be recoverable after a controller restart, not running
  // forever merely because this session was never explicitly cancelled.
  const auto expiry=SessionExpiry(client,db,newest["version"]);
  Begin(history,binding,520,1,"orphaned-running");
  const auto cleanup=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
  Check(cleanup.at("refs").empty()&&cleanup.at("cleanup_refs").size()==1&&cleanup.at("cleanup_refs")[0]==newest);
  Check(cleanup.at("cleanup_refs")[0].size()==4); // No query, image, or job secret.
  const auto proof=Inspect(history,newest,profile);
  Check(proof.at("status")=="submitted"&&proof.at("submitted").at("job_id")==Id(520)&&proof.at("submitted").at("request_id")=="orphaned-running");
  Check(history.ReadSearch(newest["search_id"],"operator")->items[0].verification->at("state")=="running");
  Check(SessionExpiry(client,db,newest["version"])==expiry); // Discovery never extends TTL.
  Check(Abort(history,binding,520,2,"orphaned-running","request_timeout").at("stored")==true);
  Check(history.ReadSearch(newest["search_id"],"operator")->items[0].verification->at("state")=="unavailable");
  const auto recovered=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
  Check(recovered.at("cleanup_refs").empty()&&recovered.at("refs")[0]==oldest);
  Check(SessionExpiry(client,db,newest["version"])==expiry);
}
class RunningServer {
 public:
  explicit RunningServer(HttpService& service){service.Register(server);port=server.bind_to_any_port("127.0.0.1");Check(port>0);
    thread=std::thread([&]{server.listen_after_bind();});for(int i=0;i<200&&!server.is_running();++i)std::this_thread::sleep_for(std::chrono::milliseconds(5));Check(server.is_running());}
  ~RunningServer(){server.stop();if(thread.joinable())thread.join();}
  httplib::Server server;int port=0;std::thread thread;
};
void HttpCases(HistoryMongo& history){
  history.Put(Make(30,Now()-100));const auto target=Open(history,300,{30}),profile=Profile();
  HttpAccess access;access.console_key=std::string(48,'c');access.producer_key=std::string(48,'p');access.management_key=std::string(48,'m');
  access.revision=std::string(64,'a');access.enabled=true;access.unavailable_reason.clear();
  HttpService service(&history,access);RunningServer running(service);httplib::Client client("127.0.0.1",running.port);
  client.set_connection_timeout(2);client.set_read_timeout(10);client.set_write_timeout(10);
  const auto post=[&](const Json& body,const char* token,int expected){
    const auto response=client.Post("/v1/searches/verification",{{"x-service-token",std::string(48,*token)}},body.dump(),"application/json");
    Check(response&&response->status==expected);Check(response->get_header_value("Cache-Control")=="no-store");return Json::parse(response->body);
  };
  Json inspect{{"action","inspect"},{"target",target},{"profile",profile},{"question_scope","visible"}};
  post(inspect,"p",403);post(inspect,"m",403);post(inspect,"x",401);
  const auto binding=post(inspect,"c",200).at("binding");
  auto bad=inspect;bad["query"]="caller cannot replace the stored query";post(bad,"c",400);
  Json queue{{"action","queued"},{"binding",binding},{"profile",profile},{"job_id",Id(530)},{"generation",0}};
  Check(post(queue,"c",200).at("status")=="queued");
  Check(post({{"action","begin"},{"binding",binding},{"job_id",Id(530)},{"generation",1},{"request_id","http-attempt"}},"c",200).at("status")=="submit");
  Check(post({{"action","finish"},{"binding",binding},{"job_id",Id(530)},{"generation",1},{"request_id","http-attempt"},
    {"result",Result(binding,profile,"http-attempt")}},"c",200).at("stored")==true);
  auto read=client.Post("/v1/searches/read",{{"x-service-token",std::string(48,'c')}},
    Json{{"id",target["search_id"]},{"actor","operator"},{"offset",0},{"limit",20}}.dump(),"application/json");
  Check(read&&read->status==200);const auto page=Json::parse(read->body);
  Check(page.at("items")[0].at("verification").at("state")=="match"&&page.at("items")[0].at("verification").at("request_id")=="http-attempt");
}
void CacheQuota(mongoc_client_t* client,const std::string& uri,const std::string& db){
  HistoryBudget budget;budget.max_searches=1;HistoryMongo history(uri,db,budget);history.Initialize();const auto at=Now()-100;
  for(int n=40;n<47;++n)history.Put(Make(n,at));
  const auto profile=Profile();auto target=Open(history,400,{40,41,42,43,44});
  for(int n=40;n<45;++n){target["sample_id"]=Id(n);const auto binding=Inspect(history,target,profile).at("binding");
    Queue(history,binding,profile,600+n);Begin(history,binding,600+n,1,"quota-"+std::to_string(n));
    Check(Finish(history,binding,600+n,1,"quota-"+std::to_string(n),Result(binding,profile,"quota-"+std::to_string(n))).at("stored")==true);
  }
  const auto finished_scan=history.SearchVerification({{"action","scan"},{"profile_fp",profile["profile_fp"]},{"cursor",nullptr}});
  Check(finished_scan.at("refs").empty());
  Command(client,db,{{"update","search_sessions"},{"updates",Json::array({{{"q",{{"version",target["version"]}}},
    {"u",{{"$set",{{"expires_at",{{"$date",{{"$numberLong",std::to_string(Now()-1)}}}}}}}}}}})}});
  target=Open(history,401,{45,46});
  for(int n=45;n<47;++n){target["sample_id"]=Id(n);const auto binding=Inspect(history,target,profile).at("binding");
    Queue(history,binding,profile,600+n);Begin(history,binding,600+n,1,"quota-"+std::to_string(n));
    Check(Finish(history,binding,600+n,1,"quota-"+std::to_string(n),Result(binding,profile,"quota-"+std::to_string(n))).at("stored")==true);
  }
  Check(CacheLimits(client,db,at+60000,5)==5); // Cache-full does not fail the owned result.
}
int main(){if(!std::getenv("AINVR_SEARCH_TEST_MONGO")){std::cout<<"SKIP: isolated Mongo required\n";return 77;}
  const std::string uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000",db="ainvr_search_verification_test_"+std::to_string(Now());mongoc_init();
  std::unique_ptr<mongoc_client_t,decltype(&mongoc_client_destroy)> client(mongoc_client_new(uri.c_str()),mongoc_client_destroy);
  auto cleanup=[&]{for(const auto& name:{db,db+"_scan",db+"_quota"})Command(client.get(),name,{{"dropDatabase",1}});};
  try{HistoryMongo history(uri,db);history.Initialize();MainCases(history,client.get(),db,uri);HttpCases(history);HistoryMongo scan(uri,db+"_scan");scan.Initialize();ScanCases(scan,client.get(),db+"_scan");CacheQuota(client.get(),uri,db+"_quota");
    cleanup();std::cout<<checks<<" native verification checks passed (isolated Mongo; no model inference)\n";
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';try{cleanup();}catch(...){}return 1;}}

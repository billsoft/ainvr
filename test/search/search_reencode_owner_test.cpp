// Pure fake sessions. Synthetic JPEG headers test contracts, not a decoder or
// semantic accuracy. No SDK, GLES, device, model or production configuration.
#include "output/search_hardware_owner.hpp"
#include "api/search_reencode_handler.hpp"
#include "search_frame_fixture.hpp"
#include <atomic>
#include <condition_variable>
#include <iostream>
#include <limits>
using namespace ai_service::output;
using namespace search_test;
using Pin=ainvr::search::RuntimeModelPin;
using Status=SearchReencodeResult::Status;
using Time=std::chrono::steady_clock::time_point;
Pin Target(char c='a'){return {"candidate-package",std::string(64,c),"search-v1-"+std::string(64,c)};}
std::vector<uint8_t> Jpeg(int w=104,int h=320){return {255,216,255,192,0,8,8,uint8_t(h>>8),uint8_t(h),uint8_t(w>>8),uint8_t(w),1,255,217};}
struct State {
 std::atomic<int> creates{0},destroys{0},calls{0},verifies{0};std::atomic<bool> affine{true};
 std::mutex mutex;std::condition_variable cv;bool block_load=false,block_encode=false,entered=false;
 std::thread::id thread;int corrupt=0;std::string error;std::vector<const uint8_t*> input_addresses;
 void Gate(bool load){std::unique_lock<std::mutex> lock(mutex);
   if(load?!block_load:!block_encode)return;
   entered=true;cv.notify_all();cv.wait(lock,[&]{return load?!block_load:!block_encode;});}
 void Wait(){std::unique_lock<std::mutex> lock(mutex);cv.wait(lock,[&]{return entered;});}
 void Release(){std::lock_guard<std::mutex> lock(mutex);block_load=block_encode=false;cv.notify_all();}
};
struct Session:SearchHardwareSession {
 std::shared_ptr<State> s;Pin pin;
 Session(std::shared_ptr<State> state,Pin p):s(std::move(state)),pin(std::move(p)){
  if(s->creates++==0)s->thread=std::this_thread::get_id();else s->affine=s->affine&&s->thread==std::this_thread::get_id();}
 ~Session(){s->affine=s->affine&&s->thread==std::this_thread::get_id();++s->destroys;}
 SearchEmbeddingSpace Space()const override{return {pin.package_id,pin.model_version,"input-v1"};}
 std::function<bool()> HealthReader()const override{return []{return true;};}
 SearchHardwareProduct Prepare(const FrozenSearchFrame&,const SearchSamplingCurrent&)override{
  s->Gate(false);throw std::logic_error("fake_prepare_completed_without_hardware");}
 SearchReencodeResult ReencodeJpeg(const std::vector<uint8_t>& bytes,const SearchSamplingCurrent& current)override{
  s->affine=s->affine&&s->thread==std::this_thread::get_id();++s->calls;s->input_addresses.push_back(bytes.data());s->Gate(false);
  if(!current())throw std::runtime_error("cancelled");
  if(!s->error.empty())throw std::runtime_error(s->error);
  auto result=SearchReencodeResult{Status::Ready,Space(),std::vector<float>(768,0),104,320};result.embedding[0]=1;
  if(s->corrupt==1)result.embedding[0]=std::numeric_limits<float>::quiet_NaN();
  if(s->corrupt==2)result.embedding[0]=2;
  if(s->corrupt==3)result.image_width=112;
  if(s->corrupt==4)result.space.model_version=Target('b').model_version;
  if(s->corrupt==5)result.embedding.clear();
  if(s->corrupt==6)result.status=Status::Unsupported;
  return result;
 }
};
SearchHardwareOwner::PinnedFactory Factory(std::shared_ptr<State> s){return [s](const std::string& package,const std::optional<Pin>& target,const SearchSamplingCurrent& current){
 ++s->verifies;s->Gate(true);if(!current())throw std::runtime_error("stale_after_verify");
 if(!target||package!=target->package_id)throw std::runtime_error("invalid_fake_pin");
 if(s->error=="ion_budget_exceeded")throw std::runtime_error(s->error);
 return std::make_unique<Session>(s,*target);
};}
void HandlerTests(){
 using namespace ai_service::api;
 auto state=std::make_shared<State>();auto owner=std::make_shared<SearchHardwareOwner>(Factory(state));
 auto target=Target();target.package_id="siglip2-base-full-int8";const auto raw=Jpeg();const std::string jpeg(raw.begin(),raw.end());
 const auto wall=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
 auto input=nlohmann::json{{"schema_version","search-reencode-image-v1"},{"request_id","00000000-0000-4000-8000-000000000001"},
   {"job_id","00000000-0000-4000-8000-000000000002"},{"generation",1},{"payload_fingerprint",std::string(64,'a')},
   {"target",{{"package_id",target.package_id},{"package_sha256",target.package_sha256},{"model_version",target.model_version}}},
   {"sample_id","00000000-0000-4000-8000-000000000003"},{"source_fingerprint",std::string(64,'b')},
   {"jpeg_sha256",ainvr::search::SampleSha256(raw.data(),raw.size())},{"expires_ms",wall+5000}};
 auto rejects=[&](const SearchReencodeImage& handler,const nlohmann::json& request,const std::string& image,int status){
   try{(void)handler(request,image);Check(false,"handler_expected_api_error");}
   catch(const ApiError& e){Check(e.status_code()==status,"handler_wrong_error_status");}
 };
 try{(void)MakeSearchReencodeHandler(owner,{});Check(false,"handler_allowed_missing_license_oracle");}
 catch(const std::invalid_argument&){Check(true,"required_license_oracle");}
 rejects(MakeSearchReencodeHandler(owner,[]{return false;}),input,jpeg,403);
 rejects(MakeSearchReencodeHandler(owner,[]{return true;},[]{return false;}),input,jpeg,410);
 Check(state->creates==0,"unauthorized_handler_loaded_model");
 auto handler=MakeSearchReencodeHandler(owner,[]{return true;});
 auto expired=input;expired["expires_ms"]=wall-1;rejects(handler,expired,jpeg,410);
 auto wrong=input;wrong["target"]["package_id"]="candidate-package";rejects(handler,wrong,jpeg,503);
 const auto response=handler(input,jpeg);
 for(const auto& [key,value]:input.items())Check(response.at(key)==value,"handler_did_not_echo_exact_binding");
 Check(response.at("input_kind")=="retained-jpeg"&&response.at("preprocessing_version")==kSearchReencodePreprocessing&&
   response.at("image_width")==104&&response.at("image_height")==320&&response.at("dimensions")==768&&response.at("vector").size()==768,"handler_wrong_response_contract");
 rejects(handler,input,std::string("\xff\xd8\xff\xd9",4),422);
 state->error="ion_budget_exceeded";rejects(handler,input,jpeg,429);state->error.clear();
 state->corrupt=1;rejects(handler,input,jpeg,503);owner->Stop();
}
void RealtimePriority(){
 Fixture f;auto state=std::make_shared<State>();SearchHardwareOwner owner(Factory(state));
 f.doc["model"]["expected_model_version"]=Target().model_version;
 f.doc["model"]["expected_package_sha256"]=Target().package_sha256;f.doc["revision"]=std::string(64,'c');f.Renew();
 owner.Refresh(f.authority->Read());Await([&]{owner.Tick();return bool(owner.CurrentSpace());});
 auto lease=*f.authority->Read();SearchSamplingPolicy policy;
 const auto parsed=SearchSamplingPolicy::FrameFromResult(f.result,f.input,1000);Check(bool(parsed),"priority_frame");
 policy.BindSource(parsed->binding);auto object=SearchSamplingPolicy::ObjectFromResult(f.result,"track-7",true,.5,{});
 const auto candidate=policy.ProposeObject(*parsed,*object);Check(bool(candidate.candidate),"priority_candidate");
 SearchWorkBudget budget;budget.Configure(1,16*1024*1024);auto ticket=budget.TryAcquire(f.raw->pixels.capacity());
 auto frozen=FreezeSearchFrame(lease,*candidate.candidate,f.result,f.capture,f.capture.fence,f.raw,std::move(*ticket));
 Check(bool(frozen),"priority_freeze");state->block_encode=true;
 auto prepare=std::async(std::launch::async,[&]{try{owner.Prepare(*frozen.frame,*owner.CurrentSpace(),lease,[]{return true;});}
   catch(const std::logic_error&){return true;}return false;});state->Wait();
 const auto jpeg=Jpeg();
 Check(owner.Reencode(Target('b'),jpeg,std::chrono::steady_clock::now()+std::chrono::seconds(5),[]{return true;}).status==Status::Busy,
   "background_migration_queued_while_realtime_borrow_active");
 Check(state->creates==1&&state->calls==0,"background_model_loaded_before_realtime_finished");
 state->Release();Check(prepare.get(),"borrowed_prepare_returned_before_affine_completion");
 Check(owner.Reencode(Target('b'),jpeg,std::chrono::steady_clock::now()+std::chrono::seconds(5),[]{return true;}).status==Status::Ready,
   "background_did_not_resume_when_realtime_idle");owner.Stop();
}
int main(){try{
 HandlerTests();RealtimePriority();
 const auto jpeg=Jpeg();std::atomic<int64_t> clock_ms{0};auto clock=[&]{return Time{}+std::chrono::milliseconds(clock_ms.load());};
 {auto state=std::make_shared<State>();SearchHardwareOwner owner(Factory(state),clock);auto valid=[]{return true;};
  auto r=owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(10),valid);
  Check(r.status==Status::Ready&&r.space.model_version==Target().model_version&&r.image_width==104&&r.image_height==320,"initial_reencode");
  Check(state->creates==1&&state->calls==1&&!owner.CurrentSpace(),"migration_changed_live_space");
  Check(state->input_addresses.front()!=jpeg.data(),"borrow_not_copied_to_bounded_task");
  r=owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(20),valid);
  Check(r.status==Status::Ready&&state->creates==1&&state->calls==2,"same_target_not_cached");
  r=owner.Reencode(Target('b'),jpeg,clock()+std::chrono::seconds(20),valid);
  Check(r.status==Status::Ready&&state->creates==2&&state->destroys==1,"target_cache_not_replaced");
  clock_ms=21000;Await([&]{owner.Tick();return state->destroys==2;});
  Check(!owner.CurrentSpace()&&owner.Tick()==SearchHardwareOwner::State::Disabled,"ttl_changed_live_state");
  Check(owner.Reencode(Target('b'),jpeg,clock()+std::chrono::seconds(5),valid).status==Status::Ready&&state->creates==3,"expired_target_reused");
  owner.Stop();Check(state->destroys==3&&state->affine,"target_destroy_not_affine");
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),valid).status==Status::Stale,"stopped_owner_admitted");}
 clock_ms=0;
 {auto state=std::make_shared<State>();SearchHardwareOwner owner(Factory(state),clock);auto valid=[]{return true;};
  std::vector<std::vector<uint8_t>> invalid{ {},{255,216,255,217},Jpeg(1,320),Jpeg(105,320),Jpeg(104,321),Jpeg(8192,8192),Jpeg(16,15),Jpeg(8193,16),std::vector<uint8_t>(kSearchReencodeMaxJpegBytes+1,0)};
  for(const auto& bytes:invalid)Check(owner.Reencode(Target(),bytes,clock()+std::chrono::seconds(5),valid).status==Status::Unsupported,"bad_jpeg_admitted");
  auto bad=Target();bad.package_sha256[0]='Z';Check(owner.Reencode(bad,jpeg,clock()+std::chrono::seconds(5),valid).status==Status::Unsupported,"bad_pin_admitted");
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(31),valid).status==Status::Unsupported,"long_ttl_admitted");
  Check(owner.Reencode(Target(),jpeg,clock(),valid).status==Status::Stale,"expired_admitted");
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return false;}).status==Status::Stale,"revoked_admitted");
  Check(state->creates==0&&state->verifies==0,"bad_request_loaded_model");owner.Stop();}
 {auto state=std::make_shared<State>();SearchHardwareOwner legacy([state](const std::string&){++state->creates;return std::unique_ptr<SearchHardwareSession>{};},clock);
  Check(legacy.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;}).status==Status::Unsupported&&state->creates==0,"unverified_factory_loaded");legacy.Stop();}
 for(int corrupt=1;corrupt<=6;++corrupt){auto state=std::make_shared<State>();state->corrupt=corrupt;SearchHardwareOwner owner(Factory(state),clock);
  auto r=owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;});
  Check(r.status==(corrupt==6?Status::Unsupported:Status::Failed)&&r.embedding.empty(),"invalid_session_result_exposed");
  Check(state->destroys==1&&!owner.CurrentSpace(),"invalid_session_cache_retained");owner.Stop();}
 {auto state=std::make_shared<State>();state->error="ion_budget_exceeded";SearchHardwareOwner owner(Factory(state),clock);
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;}).status==Status::Busy&&state->creates==0,"admission_not_busy");owner.Stop();}
 for(bool loading:{true,false}){auto state=std::make_shared<State>();state->block_load=loading;state->block_encode=!loading;
  std::atomic<bool> valid{true};SearchHardwareOwner owner(Factory(state),clock);
  auto pending=std::async(std::launch::async,[&]{return owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[&]{return valid.load();});});state->Wait();
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;}).status==Status::Busy,"parallel_reencode_not_bounded");
  valid=false;state->Release();Check(pending.get().status==Status::Stale,"late_result_not_fenced");
  Check(state->creates==(loading?0:1)&&state->destroys==state->creates,"stale_target_retained");owner.Stop();}
 {auto state=std::make_shared<State>();state->block_encode=true;SearchHardwareOwner owner(Factory(state),clock);
  auto pending=std::async(std::launch::async,[&]{return owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;});});state->Wait();
  auto stop=std::async(std::launch::async,[&]{owner.Stop();});Await([&]{return owner.Tick()==SearchHardwareOwner::State::Stopped;});
  Check(stop.wait_for(std::chrono::seconds(0))!=std::future_status::ready,"stop_escaped_borrowed_task");state->Release();
  Check(pending.get().status==Status::Stale,"stop_exposed_stale_vector");stop.get();Check(state->destroys==1&&state->affine,"stop_nonaffine_cache");}
 {Fixture f;f.doc["model"]["expected_model_version"]=Target().model_version;f.doc["model"]["expected_package_sha256"]=Target().package_sha256;f.doc["revision"]=std::string(64,'c');f.Renew();
  auto state=std::make_shared<State>();SearchHardwareOwner owner(Factory(state),clock);owner.Refresh(f.authority->Read());
  Await([&]{owner.Tick();return bool(owner.CurrentSpace());});auto live=*owner.CurrentSpace();
  Check(owner.Reencode(Target(),jpeg,clock()+std::chrono::seconds(5),[]{return true;}).status==Status::Ready&&state->creates==1,"same_pin_live_session_not_reused");
  Check(owner.Reencode(Target('b'),jpeg,clock()+std::chrono::seconds(5),[]{return true;}).status==Status::Ready&&state->creates==2,"independent_target_not_loaded");
  Check(owner.CurrentSpace()&&*owner.CurrentSpace()==live,"target_overwrote_live_space");
  clock_ms=6000;Await([&]{owner.Tick();return state->destroys==1;});Check(owner.CurrentSpace()&&*owner.CurrentSpace()==live,"target_ttl_unloaded_live");
  owner.Stop();Check(state->destroys==2&&state->affine,"live_target_shutdown_not_affine");}
 std::cout<<"search reencode owner software checks: "<<checks<<" passed; no hardware executed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

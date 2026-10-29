// Software fake factory and synthetic bytes only; no SDK/EGL/model load.
#include "output/search_hardware_owner.hpp"
#include "output/search_hardware_plan.hpp"
#include <iostream>
#include <thread>
#include <condition_variable>
#include <atomic>
using namespace ai_service;
using namespace ai_service::config;
using namespace ai_service::output;
#include "search_frame_fixture.hpp"
using namespace search_test;
struct FakeState {
 std::mutex mutex;std::condition_variable cv;bool block=false,entered=false;
 std::thread::id owner;int creates=0,destroys=0,prepares=0;
 std::shared_ptr<std::atomic<bool>> healthy=std::make_shared<std::atomic<bool>>(true);
};
struct FakeSession:SearchHardwareSession {
 std::shared_ptr<FakeState> state;std::string package,version;
 FakeSession(std::shared_ptr<FakeState> s,std::string p,std::string v="model-v1"):state(std::move(s)),package(std::move(p)),version(std::move(v)){
   std::unique_lock<std::mutex> lock(state->mutex);state->owner=std::this_thread::get_id();++state->creates;state->entered=true;state->cv.notify_all();state->cv.wait(lock,[&]{return !state->block;});
 }
 ~FakeSession(){Check(state->owner==std::this_thread::get_id(),"non-affine destruction");++state->destroys;}
 SearchEmbeddingSpace Space()const override{return {package,version,"input-v1"};}
 std::function<bool()> HealthReader()const override{auto h=state->healthy;return [h]{return h->load();};}
 SearchHardwareProduct Prepare(const FrozenSearchFrame&,const SearchSamplingCurrent& current)override{
   Check(state->owner==std::this_thread::get_id(),"non-affine prepare");++state->prepares;
   if(!current())throw std::runtime_error("stale");
   ainvr::SnapshotPlan plan;plan.width=plan.height=18;plan.source_rectangle={0,0,8,4};
   return {plan,{255,216,255,217},std::vector<float>(768,1),"gles","jpu","gles"};
 }
};
std::string Version(char hash){return "search-v1-"+std::string(64,hash);}
SearchProducerLease SetPin(Fixture& f,char hash,char revision){
 f.doc["model"]["expected_model_version"]=Version(hash);f.doc["model"]["expected_package_sha256"]=std::string(64,hash);
 f.doc["revision"]=std::string(64,revision);f.Renew();return *f.authority->Read();
}
void PinTests(){
 using Pin=ainvr::search::RuntimeModelPin;
 {Fixture f;auto lease=SetPin(f,'a','c');auto state=std::make_shared<FakeState>();std::atomic<int> calls{0};
  SearchHardwareOwner legacy([&](const std::string& package){++calls;return std::make_unique<FakeSession>(state,package);});
  legacy.Refresh(lease);Await([&]{return legacy.Tick()==SearchHardwareOwner::State::Failed;});
  Check(calls==0&&state->creates==0&&!legacy.CurrentSpace(),"pinned_grant_called_unverifiable_legacy_loader");legacy.Stop();}
 {Fixture f;auto lease=SetPin(f,'a','c');auto state=std::make_shared<FakeState>();std::string actual=Version('a');std::atomic<int> verifies{0};
  SearchHardwareOwner pinned(SearchHardwareOwner::PinnedFactory([&](const std::string& package,const std::optional<Pin>& expected,const SearchSamplingCurrent& current){
    ++verifies;const Pin verified{package,actual.substr(10),actual};
    if(!expected||!ainvr::search::MatchesRuntimeModelPin(*expected,verified))throw std::runtime_error("fake_verified_pin_mismatch");
    if(!current())throw std::runtime_error("fake_stale_before_load");
    return std::make_unique<FakeSession>(state,package,actual);
  }));
  pinned.Refresh(lease);Await([&]{pinned.Tick();return bool(pinned.CurrentSpace());});
  Check(pinned.CurrentSpace()->model_version==Version('a')&&state->creates==1&&verifies==1,"matching_pin_not_ready");
  f.Renew();lease=*f.authority->Read();Check(pinned.Refresh(lease)==SearchHardwareOwner::State::Ready&&verifies==1,"pin_renewal_reloaded_model");
  // Simulate same package ID with a different newly verified HBM/content digest.
  // The fake SDK allocation count MUST remain unchanged on mismatch.
  actual=Version('b');pinned.Refresh(lease,true);Await([&]{return pinned.Tick()==SearchHardwareOwner::State::Failed;});
  Check(verifies==2&&state->creates==1&&state->destroys==1&&!pinned.CurrentSpace(),"same_id_changed_package_loaded_before_pin_check");
  lease=SetPin(f,'b','d');pinned.Refresh(lease);Await([&]{pinned.Tick();return bool(pinned.CurrentSpace());});
  Check(verifies==3&&state->creates==2&&pinned.CurrentSpace()->model_version==Version('b'),"new_authorized_pin_not_loaded");pinned.Stop();}
 {Fixture f;auto lease=SetPin(f,'a','c');auto state=std::make_shared<FakeState>();
  std::mutex gate;std::condition_variable changed;bool entered=false,release=false;std::atomic<int> verifies{0};
  SearchHardwareOwner pinned(SearchHardwareOwner::PinnedFactory([&](const std::string& package,const std::optional<Pin>& expected,const SearchSamplingCurrent& current){
    ++verifies;const Pin verified{package,std::string(64,'a'),Version('a')};
    if(!expected||!ainvr::search::MatchesRuntimeModelPin(*expected,verified))throw std::runtime_error("fake_verified_pin_mismatch");
    {std::unique_lock<std::mutex> lock(gate);entered=true;changed.notify_all();changed.wait(lock,[&]{return release;});}
    if(!current())throw std::runtime_error("fake_stale_before_load");
    return std::make_unique<FakeSession>(state,package,Version('a'));
  }));
  pinned.Refresh(lease);{std::unique_lock<std::mutex> lock(gate);changed.wait(lock,[&]{return entered;});}
  auto stop=std::async(std::launch::async,[&]{pinned.Stop();});
  Await([&]{return pinned.Tick()==SearchHardwareOwner::State::Stopped;});
  {std::lock_guard<std::mutex> lock(gate);release=true;}changed.notify_all();stop.get();
  Check(verifies==1&&state->creates==0&&state->destroys==0,"stop_during_verify_allocated_model");}
 {Fixture f;auto lease=SetPin(f,'a','c');auto state=std::make_shared<FakeState>();
  std::mutex gate;std::condition_variable changed;bool entered=false,release=false,first=true;std::string actual=Version('a');std::atomic<int> verifies{0};
  SearchHardwareOwner pinned(SearchHardwareOwner::PinnedFactory([&](const std::string& package,const std::optional<Pin>& expected,const SearchSamplingCurrent& current){
    std::string checked;
    {std::unique_lock<std::mutex> lock(gate);checked=actual;++verifies;
      if(first){first=false;entered=true;changed.notify_all();changed.wait(lock,[&]{return release;});}}
    const Pin verified{package,checked.substr(10),checked};
    if(!expected||!ainvr::search::MatchesRuntimeModelPin(*expected,verified))throw std::runtime_error("fake_verified_pin_mismatch");
    if(!current())throw std::runtime_error("fake_stale_before_load");
    return std::make_unique<FakeSession>(state,package,checked);
  }));
  pinned.Refresh(lease);{std::unique_lock<std::mutex> lock(gate);changed.wait(lock,[&]{return entered;});}
  auto next=SetPin(f,'b','d');pinned.Refresh(next);
  {std::lock_guard<std::mutex> lock(gate);actual=Version('b');release=true;}changed.notify_all();
  Await([&]{pinned.Tick();return bool(pinned.CurrentSpace());});
  Check(verifies==2&&state->creates==1&&pinned.CurrentSpace()->model_version==Version('b'),"changed_pin_during_verify_loaded_old_model");pinned.Stop();}
}
int main(){try{
 PinTests();
 {auto odd=SearchHardwarePlan({10,10,21,19},640,320,false,320,0);
  Check(odd.width==22&&odd.height==20,"odd canvas not explicit even");Check(odd.source_rectangle==std::array<double,4>{10,10,21,19},"odd FOV changed");
  auto tiny=SearchHardwarePlan({0,0,2,2},8,4,false,320,0);Check(tiny.width==18&&tiny.height==18,"tiny canvas below JPU minimum");
  Check(tiny.source_rectangle==std::array<double,4>{0,0,2,2},"tiny FOV changed");
  auto scene=SearchHardwarePlan({},1920,1080,true,1280,0);Check(scene.source_rectangle==std::array<double,4>{0,0,1920,1080},"scene not full raw frame");}
 Fixture f;auto state=std::make_shared<FakeState>();state->block=true;
 SearchHardwareOwner owner([state](const std::string& p){return std::make_unique<FakeSession>(state,p);});
 Check(!owner.CurrentSpace(),"idle owner ready");auto lease=*f.authority->Read();
 Check(owner.Refresh(lease)==SearchHardwareOwner::State::Loading,"refresh not async loading");
 Await([&]{std::lock_guard<std::mutex> lock(state->mutex);return state->entered;});
 Check(!owner.CurrentSpace(),"load unfinished ready");
 {std::lock_guard<std::mutex> lock(state->mutex);state->block=false;}state->cv.notify_all();
 Await([&]{owner.Tick();return bool(owner.CurrentSpace());});
 Check(state->owner!=std::this_thread::get_id(),"load on control thread");
 auto space=*owner.CurrentSpace();f.now+=std::chrono::seconds(1);f.Renew();lease=*f.authority->Read();
 Check(owner.Refresh(lease)==SearchHardwareOwner::State::Ready&&state->creates==1,"renewal reloaded model");
 SearchSamplingPolicy policy;auto parsed=SearchSamplingPolicy::FrameFromResult(f.result,f.input,1000);Check(bool(parsed),"frame parse");
 policy.BindSource(parsed->binding);auto object=SearchSamplingPolicy::ObjectFromResult(f.result,"track-7",true,.5,{});
 auto candidate=policy.ProposeObject(*parsed,*object);Check(bool(candidate.candidate),"candidate absent");
 SearchWorkBudget budget;budget.Configure(2,16*1024*1024);auto ticket=budget.TryAcquire(f.raw->pixels.capacity());
 auto frozen=FreezeSearchFrame(lease,*candidate.candidate,f.result,f.capture,f.capture.fence,f.raw,std::move(*ticket));Check(bool(frozen),"freeze failed");
 auto sample=owner.Prepare(*frozen.frame,space,lease,[]{return true;});Check(bool(sample)&&sample->sample->record.vector.size()==768,"prepare failed");
 auto again=owner.Prepare(*frozen.frame,space,lease,[]{return true;});Check(again->sample->record.id==sample->sample->record.id,"same slot storage ID unstable");
 Check(sample->sample->evidence["source_pts_ns"]=="1000000000"&&sample->sample->evidence["source_frame_index"]=="1","identity used raw timestamp");
 f.Advance(2);auto next_candidate=*candidate.candidate;
 next_candidate.frame=*SearchSamplingPolicy::FrameFromResult(f.result,f.input,2000);ticket=budget.TryAcquire(f.raw->pixels.capacity());
 auto next_frame=FreezeSearchFrame(lease,next_candidate,f.result,f.capture,f.capture.fence,f.raw,std::move(*ticket));Check(bool(next_frame),"replacement freeze failed");
 auto replacement=owner.Prepare(*next_frame.frame,space,lease,[]{return true;});
 Check(replacement->sample->record.id==sample->sample->record.id,"replacement generated another slot document");
 Check(replacement->sample->evidence["frame_id"]!=sample->sample->evidence["frame_id"],"replacement reused prior frame identity");
 Check(replacement->sample->evidence["image_width"]==18&&replacement->sample->evidence["raw_frame_width"]==8,"encoded and original dimensions confused");
 Check(!owner.Prepare(*frozen.frame,space,lease,[]{return false;}),"stale frame prepared");
 state->healthy->store(false);Check(!owner.CurrentSpace(),"fatal latch ready");state->healthy->store(true);
 f.authority->Invalidate();Check(!owner.CurrentSpace(),"revoked lease ready");
 owner.Refresh({});Await([&]{return owner.Tick()==SearchHardwareOwner::State::Disabled;});Check(state->destroys==1,"disable did not affine release");
 owner.Stop();Check(owner.Tick()==SearchHardwareOwner::State::Stopped,"stop not final");
 // A load completing after revocation cannot install stale readiness.
 Fixture g;auto late=std::make_shared<FakeState>();late->block=true;
 SearchHardwareOwner slow([late](const std::string& p){return std::make_unique<FakeSession>(late,p);});slow.Refresh(g.authority->Read());
 Await([&]{std::lock_guard<std::mutex> lock(late->mutex);return late->entered;});slow.Refresh({});
 {std::lock_guard<std::mutex> lock(late->mutex);late->block=false;}late->cv.notify_all();
 Await([&]{return slow.Tick()==SearchHardwareOwner::State::Disabled;});Check(!slow.CurrentSpace()&&late->destroys==1,"late load installed or leaked");slow.Stop();
 // Shutdown fences synchronously, then joins the borrowed/model owner task.
 Fixture h;auto stopping=std::make_shared<FakeState>();stopping->block=true;
 SearchHardwareOwner closing([stopping](const std::string& p){return std::make_unique<FakeSession>(stopping,p);});closing.Refresh(h.authority->Read());
 Await([&]{std::lock_guard<std::mutex> lock(stopping->mutex);return stopping->entered;});
 std::atomic<bool> stopped=false;std::thread shutdown([&]{closing.Stop();stopped=true;});
 Await([&]{return closing.Tick()==SearchHardwareOwner::State::Stopped;});Check(!stopped.load(),"shutdown escaped active borrowed task");
 {std::lock_guard<std::mutex> lock(stopping->mutex);stopping->block=false;}stopping->cv.notify_all();shutdown.join();
 Check(stopped&&stopping->destroys==1&&!closing.CurrentSpace(),"shutdown did not affine destroy late model");
 std::cout<<"search hardware owner software checks: "<<checks<<" passed; no hardware executed\n";return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

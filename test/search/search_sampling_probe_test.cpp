// Software contract: fabricated unit descriptors, no model/image/network.
#include "output/search_sampling_policy.hpp"
#include "output/search_sampling_coverage.hpp"
#include "output/search_appearance.hpp"
#include <iostream>
#include <limits>
#include <iomanip>
#include <sstream>
using namespace ai_service::output;
namespace {
using P=SearchSamplingPolicy;size_t checks=0;
void Check(bool v,const char* why){++checks;if(!v)throw std::runtime_error(why);}
std::string Fp(uint64_t n){std::ostringstream s;s<<std::hex<<std::setw(64)<<std::setfill('0')<<n;return s.str();}
SearchSamplingBinding Binding(){return {"source","processor","session",1920,1080};}
SearchSamplingFrame Frame(int ms){return {Binding(),int64_t(ms)*1000000,ms,1790000000000LL+ms,"active"};}
SearchSamplingObject Object(const SearchSamplingFrame& f,double quality=.2){
  return {"track","confirmed","detected",f.source_pts_ns,true,true,quality,{},"processor","session",f.source_frame_index,Fp(1)};
}
P::Candidate Proposed(P::Proposal p){Check(p.status==P::Status::Proposed&&bool(p.candidate),"expected_proposal");return *p.candidate;}
void Commit(P& p,const P::Candidate& c){Check(p.Resolve(c.token,P::Outcome::Committed,Fp(c.token)),"commit_failed");}
void Objects(){
  P p;Check(p.BindSource(Binding()),"bind");
  auto f=Frame(0);auto c=Proposed(p.ProposeObject(f,Object(f)));
  Check(c.reason==P::Reason::First&&!p.Resolve(c.token,P::Outcome::NoChange),"first_cannot_be_nochange");Commit(p,c);
  f=Frame(1000);c=Proposed(p.ProposeObject(f,Object(f)));
  Check(c.reason==P::Reason::ObjectProbe&&c.slot==2&&P::ProbeContractValid(c),"explicit_probe_change_slot");
  auto snap=p.Inspect(Binding(),"track");Check(snap->Count()==1&&snap->last_committed_pts_ns==0&&snap->last_checked_pts_ns==-1,"probe_no_ack_not_committed");
  Check(p.Resolve(c.token,P::Outcome::NoChange),"real_nochange_resolution");snap=p.Inspect(Binding(),"track");
  Check(snap->Count()==1&&snap->last_committed_pts_ns==0&&snap->last_checked_pts_ns==1000000000&&snap->best_quality==.2,"nochange_did_not_consume_slots_or_commit_clock");
  f=Frame(1100);Check(p.ProposeObject(f,Object(f)).status==P::Status::NotDue,"probe_not_every_detection_frame");
  f=Frame(2000);c=Proposed(p.ProposeObject(f,Object(f)));Check(p.Resolve(c.token,P::Outcome::Failed),"probe_failure");
  snap=p.Inspect(Binding(),"track");Check(snap->Count()==1&&snap->last_checked_pts_ns==1000000000&&snap->last_committed_pts_ns==0,"failure_only_attempt_clock");
  f=Frame(2100);Check(p.ProposeObject(f,Object(f)).status==P::Status::NotDue,"failed_probe_resource_throttle");
  c=Proposed(p.ProposeObject(f,Object(f,.5)));Check(c.reason==P::Reason::Best&&c.slot==1,"failed_probe_does_not_delay_best");Commit(p,c);
  f=Frame(3100);c=Proposed(p.ProposeObject(f,Object(f,.5)));Check(p.Resolve(c.token,P::Outcome::Unknown),"unknown_probe_write");
  Check(!p.Resolve(c.token,P::Outcome::NoChange),"unknown_write_not_reclassified_nochange");
  const auto retry=p.Retry(c.token);Check(retry&&retry->token==c.token&&retry->probe_reference_fingerprint==c.probe_reference_fingerprint,"unknown_same_descriptor_reference");
  f=Frame(4100);Check(p.ProposeObject(f,Object(f,.5)).status==P::Status::Pending,"unknown_blocks_new_probe");Commit(p,c);
  int ms=5100;
  for(size_t slot=3;slot<8;++slot,ms+=1000){f=Frame(ms);c=Proposed(p.ProposeObject(f,Object(f,.5)));Check(c.slot==slot,"six_distinct_change_slots");Commit(p,c);}
  snap=p.Inspect(Binding(),"track");Check(snap->Count()==8,"at_most_eight_persisted_slots");
  f=Frame(ms);c=Proposed(p.ProposeObject(f,Object(f,.5)));
  Check(c.slot==2&&c.expected_fingerprint==snap->slots[2]->fingerprint,"long_track_replaces_oldest_change_cas");
  const auto before=snap->slots[2]->fingerprint;Check(p.Resolve(c.token,P::Outcome::NoChange),"full_track_nochange");
  Check(p.Inspect(Binding(),"track")->slots[2]->fingerprint==before,"nochange_cannot_replace_slot");
  f=Frame(ms+1000);c=Proposed(p.ProposeObject(f,Object(f,.5)));Commit(p,c);Check(p.Inspect(Binding(),"track")->Count()==8,"replacement_not_append");
  p.ResetSource("source","processor");Check(!p.Resolve(c.token,P::Outcome::NoChange)&&p.Usage().tracks==0,"reset_fences_old_probe");
}
void Scenes(){
  P p;Check(p.BindSource(Binding()),"scene_bind");SearchSamplingScene s{true,true,{},Fp(1)};
  auto c=Proposed(p.ProposeScene(Frame(0),s));Check(c.reason==P::Reason::SceneFirst,"scene_first");Commit(p,c);
  c=Proposed(p.ProposeScene(Frame(3000),s));Check(c.reason==P::Reason::SceneProbe&&!c.slot,"scene_probe_independent");
  Check(p.Resolve(c.token,P::Outcome::NoChange),"scene_nochange");
  Check(p.ProposeScene(Frame(3100),s).status==P::Status::NotDue,"scene_not_each_frame");
  c=Proposed(p.ProposeScene(Frame(9000),s));Check(p.Resolve(c.token,P::Outcome::Failed),"scene_probe_failed");
  c=Proposed(p.ProposeScene(Frame(10000),s));Check(c.reason==P::Reason::SceneInterval,"failed_probe_does_not_delay_periodic_scene");Commit(p,c);
  c=Proposed(p.ProposeScene(Frame(13000),s));Commit(p,c);
  Check(p.ProposeScene(Frame(14000),s).status==P::Status::NotDue,"scene_change_ack_interval");
  auto bad=s;bad.probe_reference_fingerprint="not-a-fingerprint";
  Check(p.ProposeScene(Frame(16000),bad).status==P::Status::Invalid,"invalid_probe_reference");
}
void Coverage(){
  SearchCoverageScope scope{{"out","root","processor","out","/live/in","/live/out",true,true},"package","model","session",1,false};
  SearchCoverageLedger ledger;Check(ledger.Plan(scope,1000,1000000,1)&&ledger.Plan(scope,1000,1000000,2,true),"separate_obligations");
  Check(ledger.EndFrame(scope,1000,1000000),"probe_frame_end");ledger.Resolve(1,SearchCoverageLedger::Outcome::NoChange);
  ledger.Resolve(2,SearchCoverageLedger::Outcome::NoChange);auto r=ledger.Next(11000);
  Check(r&&r->range.state==SearchCoverageRange::State::Pending,"nochange_cannot_certify_persistent_write");
  ledger.Reported(r->id,r->version,true);ledger.Resolve(1,SearchCoverageLedger::Outcome::Committed);r=ledger.Next(11000);
  Check(r&&r->range.state==SearchCoverageRange::State::Sampled,"write_ack_plus_real_nochange_closes_window");
}
void Math(){
  const std::vector<float>a{1,0},same{2,0},orthogonal{0,1},opposite{-1,0},zero{0,0};
  Check(SearchAppearanceDistance(a,same)==0,"same_normalized_descriptor");
  Check(SearchAppearanceDistance(a,orthogonal)==1,"orthogonal_descriptor");
  Check(SearchAppearanceDistance(a,opposite)==2,"opposite_descriptor");
  Check(!SearchAppearanceDistance(a,zero)&&!SearchAppearanceDistance(a,std::vector<float>{1}),"zero_or_wrong_space");
  Check(!SearchAppearanceDistance(a,std::vector<float>{std::numeric_limits<float>::quiet_NaN(),0}),"nan_descriptor");
  Check(!SearchAppearanceDistance(a,std::vector<float>{std::numeric_limits<float>::infinity(),0}),"infinite_descriptor");
  Check(!SearchAppearanceDistance(std::vector<float>(4097,1),std::vector<float>(4097,1)),"descriptor_dimension_bound");
}
void VariableFps(){
  for(int fps:{3,5,10,30}){
    P object,scene;Check(object.BindSource(Binding())&&scene.BindSource(Binding()),"fps_bind");
    auto first=Proposed(object.ProposeObject(Frame(0),Object(Frame(0))));Commit(object,first);
    SearchSamplingScene input{true,true,{},Fp(1)};first=Proposed(scene.ProposeScene(Frame(0),input));Commit(scene,first);
    size_t object_probes=0,scene_probes=0,scene_intervals=0;
    for(int i=1;i<=10*fps;++i){
      const auto frame=Frame(i*1000/fps);auto p=object.ProposeObject(frame,Object(frame));
      if(p.candidate){Check(p.candidate->reason==P::Reason::ObjectProbe,"fps_probe_reason");++object_probes;
        Check(object.Resolve(p.candidate->token,P::Outcome::NoChange),"fps_object_nochange");}
      else Check(p.status==P::Status::NotDue,"fps_object_unexpected_refusal");
      p=scene.ProposeScene(frame,input);
      if(p.candidate){
        if(p.candidate->reason==P::Reason::SceneProbe){++scene_probes;Check(scene.Resolve(p.candidate->token,P::Outcome::NoChange),"fps_scene_nochange");}
        else{Check(p.candidate->reason==P::Reason::SceneInterval,"fps_periodic_reason");++scene_intervals;Commit(scene,*p.candidate);}
      }else Check(p.status==P::Status::NotDue,"fps_scene_unexpected_refusal");
    }
    Check(object_probes==10&&scene_probes==3&&scene_intervals==1,"probe_actual_time_not_frame_count");
    const auto track=object.Inspect(Binding(),"track");Check(track->Count()==1&&track->last_committed_pts_ns==0,"fps_nochange_preserves_first");
  }
  {
    P scene;Check(scene.BindSource(Binding()),"half_fps_bind");
    SearchSamplingScene input{true,true,{},Fp(1)};size_t probes=0,periodic=0;
    for(int ms=0;ms<=20000;ms+=2000){auto frame=Frame(ms);frame.analytics_status="detection_only";
      auto p=scene.ProposeScene(frame,input);
      if(p.candidate){if(p.candidate->reason==P::Reason::SceneProbe){++probes;Check(scene.Resolve(p.candidate->token,P::Outcome::NoChange),"half_fps_actual_observation_probe");}
        else{if(p.candidate->reason==P::Reason::SceneInterval)++periodic;Commit(scene,*p.candidate);}}
      else Check(p.status==P::Status::NotDue,"half_fps_not_synthetic_frames");
    }
    Check(probes==4&&periodic==2,"half_fps_probe_at_four_second_observations_periodic_ten");
  }
}
}
int main(){try{Objects();Scenes();Coverage();Math();VariableFps();std::cout<<checks<<" explicit probe checks passed; synthetic descriptors only\n";return 0;}
 catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

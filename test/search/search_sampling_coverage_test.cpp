#include "output/search_sampling_coverage.hpp"
#include "output/search_sampling_metrics.hpp"
#include <iostream>
#include <limits>
using namespace ai_service::output;
namespace {
size_t checks=0;
void Check(bool ok,const char* reason){++checks;if(!ok)throw std::runtime_error(reason);}
using State=SearchCoverageRange::State;
using Outcome=SearchCoverageLedger::Outcome;
SearchCoverageScope Scope(bool scene=false){
  return {{"out","root","processor","out","/live/in","/live/out",true,true},"package","model","session",1,scene};
}
void Ledger(){
  auto scope=Scope();constexpr int64_t expiry=1000000;
  {using Cause=SearchCoverageLedger::GapCause;
    SearchCoverageLedger l;
    l.EndFrame(scope,1000,expiry);l.Gap(scope,1500,expiry,Cause::ObsOrdinalJump);l.Gap(scope,1600,expiry,Cause::Ineligible);
    l.EndFrame(scope,1600,expiry);auto a=l.Next(11000);
    Check(a&&a->range.state==State::Gap,"cause_gap_state");
    const auto& s=l.Stats();
    Check(s.windows[size_t(Cause::ObsOrdinalJump)]==1&&s.windows[size_t(Cause::Ineligible)]==0,"first_cause_wins_per_window");
    Check(s.events[size_t(Cause::ObsOrdinalJump)]==1&&s.events[size_t(Cause::Ineligible)]==1,"every_event_counted");
    Check(s.reported_gap==1&&s.reported_sampled==0,"reported_state_counted");}
  {using Cause=SearchCoverageLedger::GapCause;
    SearchCoverageLedger l;l.EndFrame(scope,1000,expiry);l.Gap(scope,1100,expiry);// no EndFrame for 1100
    auto a=l.Next(11000);Check(a&&a->range.state==State::Gap,"last_frame_gap");
    Check(l.Stats().windows[size_t(Cause::Unspecified)]==1,"unspecified_default_cause_counted");}
  {using Cause=SearchCoverageLedger::GapCause;
    SearchCoverageLedger l;l.EndFrame(scope,1000,expiry);scope.generation=1;
    l.Seal(scope.source.processor_id,1);
    Check(l.Stats().windows[size_t(Cause::Seal)]==1,"seal_counted");}
  {using Cause=SearchCoverageLedger::GapCause;
    SearchCoverageLedger l;l.EndFrame(scope,1000,expiry);l.Plan(scope,1100,expiry,7);l.EndFrame(scope,1100,expiry);
    l.Resolve(7,Outcome::Failed);
    Check(l.Stats().windows[size_t(Cause::FailedWrite)]==1,"failed_write_counted");
    // Unended frame closed by timeout
    SearchCoverageLedger m;m.EndFrame(scope,1000,expiry);m.Plan(scope,1200,expiry,9);
    auto r=m.Next(12000);Check(r&&m.Stats().windows[size_t(Cause::LastFrameNoEnd)]==1,"last_frame_without_end_counted");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1),"plan1");Check(l.EndFrame(scope,1000,expiry),"end1");
    Check(l.Plan(scope,1100,expiry,2),"plan2");Check(l.EndFrame(scope,1100,expiry),"end2");
    l.Resolve(1,Outcome::Committed);auto r=l.Next(11000);
    Check(r&&r->range.state==State::Pending,"one_ack_cannot_certify_window");
    Check(r->range.from_ms==1000&&r->range.to_ms==1101,"observed_range_only");
    l.Reported(r->id,r->version,true);Check(!l.Next(11000),"pending_not_busy_retried");
    l.Resolve(2,Outcome::Unknown);Check(!l.Next(11000),"unknown_not_success");
    l.Resolve(2,Outcome::Committed);auto s=l.Next(11000);
    Check(s&&s->id==r->id&&s->range.state==State::Sampled,"all_acks_close");
    l.Reported(s->id,s->version,true);Check(l.Size()==0&&l.Pending()==0,"final_freed");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1),"early_plan");l.Resolve(1,Outcome::Committed);
    auto r=l.Next(11000);Check(r&&r->range.state==State::Gap,"ack_without_endframe_gap");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1),"race_plan");Check(l.EndFrame(scope,1000,expiry),"race_end");
    auto r=l.Next(11000);Check(r&&r->range.state==State::Pending,"pending_report");
    l.Resolve(1,Outcome::Committed);l.Reported(r->id,r->version,true);
    auto s=l.Next(11000);Check(s&&s->range.state==State::Sampled,"old_report_ack_not_erase_new_version");}
  {SearchCoverageLedger l;
    Check(l.EndFrame(scope,1000,expiry)&&l.EndFrame(scope,1100,expiry),"no_due_frames");
    Check(!l.Plan(scope,1100,expiry,1),"offers_after_endframe_rejected");
    auto r=l.Next(11000);Check(r&&r->range.state==State::Sampled,"no_due_not_missing_every_frame");
    l.Seal(scope.source.processor_id,1);l.Reported(r->id,r->version,false);
    auto s=l.Next(11000);Check(s&&s->range.state==State::Sampled,"reset_not_downgrade_completed_historical_range");}
  {SearchCoverageLedger l;
    Check(l.EndFrame(scope,1000,expiry)&&l.EndFrame(scope,3000,expiry),"capture_gap_frames");
    auto r=l.Next(11000);Check(r&&r->range.state==State::Sampled,"legitimate_sparse_observations_not_fixed_one_second_gap");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1)&&l.EndFrame(scope,1000,expiry),"reset_plan");
    l.Seal("processor",1);l.Resolve(1,Outcome::Committed);
    auto r=l.Next(11000);Check(r&&r->range.state==State::Gap,"late_ack_cannot_promote_reset_gap");
    l.Reported(r->id,r->version,true);Check(l.Size()==0&&l.Pending()==0,"reset_metadata_bounded");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1)&&l.EndFrame(scope,1000,expiry),"old_pending");
    Check(l.EndFrame(scope,12000,expiry),"next_window");
    auto r=l.Next(22000);Check(r&&r->range.state==State::Pending,"first_pending");l.Reported(r->id,r->version,true);
    auto s=l.Next(22000);Check(s&&s->range.state==State::Gap,"old_pending_not_certify_later_window");}
  {SearchCoverageLedger l(2,2);
    Check(l.EndFrame(scope,1000,expiry)&&l.EndFrame(scope,12000,expiry),"two_windows");
    Check(l.EndFrame(scope,24000,expiry)&&l.Size()==2&&l.Dropped()==1,"bounded_overflow_drops_metadata_not_sampling");
    auto r=l.Next(30000);Check(bool(r),"bounded_report");l.Reported(r->id,r->version,true);
    Check(l.EndFrame(scope,35000,expiry),"slot_reclaimed");}
  {SearchCoverageLedger l;
    for(uint64_t i=1;i<=kSearchSamplingMetadataPendingLimit;++i){auto s=scope;s.source.processor_id="p"+std::to_string(i);
      Check(l.Plan(s,1000,expiry,i),"pending_admission");}
    auto s=scope;s.source.processor_id="overflow";Check(!l.Plan(s,1000,expiry,kSearchSamplingMetadataPendingLimit+1),"metadata_pending_bound_separate_from_four_physical_jobs");
    l.SealAll();Check(l.Pending()==0,"seal_releases_pending_proofs");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,2000,1),"expiry_plan");Check(!l.Next(2000)&&l.Size()==0&&l.Pending()==1,"expired_metadata_keeps_unresolved_proof");
    l.Resolve(1,Outcome::Failed);Check(l.Pending()==0,"expired_token_resolution_bounded");
    Check(!l.EndFrame(scope,-1,expiry)&&!l.EndFrame(scope,1000,1000),"invalid_time");}
  {SearchCoverageLedger l;
    Check(l.EndFrame(scope,1000,expiry),"retry_frame");auto r=l.Next(11000);Check(bool(r),"retry_report");
    l.Reported(r->id,r->version,false);auto s=l.Next(11000);
    Check(s&&s->id==r->id&&s->version==r->version&&s->range.to_ms==r->range.to_ms,"same_unknown_put_retry");
    l.Abandon(r->id);Check(l.Size()==0,"revoked_scope_unknown_not_leaked");}
  {SearchCoverageLedger l;
    Check(l.Plan(scope,1000,expiry,1)&&l.EndFrame(scope,1000,expiry),"failed_plan");
    l.Resolve(1,Outcome::Failed);auto r=l.Next(11000);Check(r&&r->range.state==State::Gap,"archive_or_encode_reject_gap");}
  {SearchCoverageLedger l;auto scene=Scope(true);
    Check(l.EndFrame(scope,1000,expiry)&&l.EndFrame(scene,1000,expiry),"two_kinds");
    auto r=l.Next(11000);Check(bool(r),"first_report");l.Reported(r->id,r->version,false);
    auto s=l.Next(11000);Check(s&&s->id!=r->id,"bad_range_cannot_starve_other_ranges");}
}
void OverflowAndContinuity(){
  const auto s=Scope();constexpr int64_t expiry=1000000;
  {SearchCoverageLedger l;
    Check(l.EndFrame(s,1000,expiry)&&l.EndFrame(s,10967,expiry),"bridge_before");
    auto a=l.Next(11000);Check(a&&a->range.to_ms==10968,"first_report_not_delayed");
    l.Reported(a->id,a->version,true);
    Check(l.EndFrame(s,11000,expiry,10968),"proven_bridge");
    auto b=l.Next(22000);Check(b&&b->range.from_ms==10968,"next_range_fills_only_proven_interframe_boundary");}
  {SearchCoverageLedger l;
    l.EndFrame(s,1000,expiry);l.EndFrame(s,10967,expiry);l.EndFrame(s,11000,expiry,10968);
    auto a=l.Next(22000);Check(a&&a->range.from_ms==1000&&a->range.to_ms==11001&&l.Size()==1,"unsent_adjacent_final_windows_coalesced");}
  {SearchCoverageLedger l;
    l.EndFrame(s,1000,expiry);l.EndFrame(s,10967,expiry);l.EndFrame(s,13000,expiry,10968);
    auto a=l.Next(24000);Check(a&&a->range.to_ms==10968,"long_discontinuity_not_joined");}
  {SearchCoverageLedger l;
    Check(l.Plan(s,1000,expiry,1)&&l.EndFrame(s,1000,expiry),"reported_gap_pending_plan");
    l.Gap(s,1000,expiry);auto a=l.Next(11000);Check(a&&a->range.state==State::Gap,"reported_gap");
    l.Reported(a->id,a->version,true);Check(l.Size()==0&&l.Pending()==1,"gap_ack_keeps_unknown_proof");
    l.EndFrame(s,12000,expiry);auto b=l.Next(22000);Check(b&&b->range.state==State::Gap,"reported_gap_not_erase_future_obligation");
    l.Resolve(1,Outcome::Committed);Check(l.Pending()==0,"late_ack_after_final_gap");}
  {SearchCoverageLedger l;
    l.EndFrame(s,1000,expiry);l.EndFrame(s,10967,expiry);auto a=l.Next(11000);
    Check(bool(a),"retry_identity_first");l.Reported(a->id,a->version,false);
    l.EndFrame(s,11000,expiry,10968);auto b=l.Next(22000);
    Check(b&&b->range.from_ms==10968,"next_unsent_window_selected");l.Reported(b->id,b->version,true);
    auto retry=l.Next(22000);Check(retry&&retry->id==a->id&&retry->range.to_ms==a->range.to_ms,
      "lost_ack_retry_changed_range_identity_when_adjacent_window_arrived");}
  {SearchCoverageLedger l(2,2);
    Check(l.Plan(s,1000,expiry,1)&&l.EndFrame(s,1000,expiry),"unknown_old_window");
    l.EndFrame(s,12000,expiry);l.EndFrame(s,24000,expiry);
    Check(l.Dropped()==1&&l.Pending()==1,"eviction_keeps_unresolved_scope_obligation");
    l.Resolve(1,Outcome::Unknown);Check(l.Pending()==1,"lookup_unknown_keeps_dropped_window_obligation");
    auto a=l.Next(35000);Check(a&&a->range.state==State::Gap,"unknown_evicted_write_not_certify_later_window");
    l.Resolve(1,Outcome::Committed);Check(l.Pending()==0,"late_ack_releases_dropped_window_metadata_only");}
}
void Metrics(){
  const auto small=SearchObjectPixelSupport({25,25,10,10},100,100,200,200);
  const auto large=SearchObjectPixelSupport({25,25,30,30},100,100,200,200);
  Check(small&&large&&*large>*small,"larger_visible_pixel_support");
  const auto edge=SearchObjectPixelSupport({0,25,30,30},100,100,200,200);
  Check(edge&&*edge<*large,"edge_discount");
  const auto clipped=SearchObjectPixelSupport({-10,25,30,30},100,100,200,200);
  Check(clipped&&*clipped<*edge,"clipped_fraction_discount");
  const auto scaled=SearchObjectPixelSupport({50,50,60,60},200,200,200,200);
  Check(scaled&&std::abs(*scaled-*large)<1e-12,"axis_scale_invariant");
  Check(!SearchObjectPixelSupport({0,0,0,1},100,100,200,200),"zero_box");
  Check(!SearchObjectPixelSupport({0,0,1,1},0,100,200,200),"zero_dimensions");
  Check(!SearchObjectPixelSupport({101,0,1,1},100,100,200,200),"outside_box");
  Check(!SearchObjectPixelSupport({0,0,std::numeric_limits<double>::quiet_NaN(),1},100,100,200,200),"nan_reject");
  Check(!SearchObjectPixelSupport({0,0,std::numeric_limits<double>::infinity(),1},100,100,200,200),"inf_reject");
}
}
int main(){try{Ledger();OverflowAndContinuity();Metrics();std::cout<<checks<<" coverage/geometry checks passed\n";return 0;}
 catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

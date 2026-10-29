// Bounded observation-window ledger, not a queue. Caller holds its owner lock.
#pragma once
#include "config/search_producer_grant.hpp"
#include "output/search_sampling_limits.hpp"
#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <stdexcept>
namespace ai_service::output {
struct SearchCoverageScope {
  config::SearchProducerSource source;
  std::string package_id,model_version,stream_session_id;
  uint64_t generation=0;
  bool scene=false;
};
struct SearchCoverageRange {
  enum class State { Pending, Gap, Sampled };
  SearchCoverageScope scope;
  int64_t from_ms=0,to_ms=0,expires_ms=0;
  State state=State::Pending;
};
class SearchCoverageLedger {
 public:
  using Id=uint64_t;
  enum class Outcome { Committed, Failed, Unknown, NoChange, Deferred };
  // Why a window became a gap (diagnostics). The first cause wins per window;
  // events count every occurrence.
  enum class GapCause : size_t { Unspecified, HookMissedEnd, ObsInvalidTicket, ObsEpochChange,
    ObsOrdinalJump, ObsTicketPresenceChange, ObsTemporalBreak, Ineligible, Incomplete, PlanUncovered,
    FailedWrite, FailOfferInvalid, FailBudget, FailQueue, FailTrackGone, FailRetiredUnknown, FailRejected,
    DeferredTrackLost, CrossWindowPending, LastFrameNoEnd, Seal, Count };
  static constexpr size_t kGapCauses=size_t(GapCause::Count);
  static constexpr const char* GapCauseName(GapCause c) {
    switch(c){
      case GapCause::HookMissedEnd:return "missed_end_frame";
      case GapCause::ObsInvalidTicket:return "observation_invalid_ticket";
      case GapCause::ObsEpochChange:return "observation_epoch_changed";
      case GapCause::ObsOrdinalJump:return "observation_ordinal_jump";
      case GapCause::ObsTicketPresenceChange:return "observation_ticket_presence_changed";
      case GapCause::ObsTemporalBreak:return "observation_time_break";
      case GapCause::Ineligible:return "analytics_not_eligible";
      case GapCause::Incomplete:return "offers_incomplete";
      case GapCause::PlanUncovered:return "plan_not_covered";
      case GapCause::FailedWrite:return "write_failed";
      case GapCause::DeferredTrackLost:return "deferred_track_ended_before_commit";
      case GapCause::FailOfferInvalid:return "offer_failed_invalid_or_pixels";
      case GapCause::FailBudget:return "offer_failed_pixel_budget";
      case GapCause::FailQueue:return "offer_failed_executor_queue_full";
      case GapCause::FailTrackGone:return "pending_cancelled_track_gone";
      case GapCause::FailRetiredUnknown:return "pending_retired_unknown_receipt";
      case GapCause::FailRejected:return "write_rejected_by_store";
      case GapCause::CrossWindowPending:return "older_window_unresolved_write";
      case GapCause::LastFrameNoEnd:return "last_frame_without_end";
      case GapCause::Seal:return "sealed_by_reset_or_stop";
      default:return "unspecified";}
  }
  struct GapStats {
    std::array<uint64_t,kGapCauses> events{},windows{};
    uint64_t reported_sampled=0,reported_gap=0,reported_pending=0;
  };
  const GapStats& Stats()const{return stats_;}
  struct Report { Id id; uint64_t version; SearchCoverageRange range; };
  // One generation is a source lifecycle fence, not a new tracking identity.
  // A range spans observed capture times only; absent time stays unknown.
  explicit SearchCoverageLedger(size_t maximum=256,size_t per_kind=4,int64_t window_ms=10000)
      :maximum_(maximum),per_kind_(per_kind),window_ms_(window_ms) {
    if(!maximum_||maximum_>256||!per_kind_||per_kind_>4||window_ms_<1||window_ms_>60000)
      throw std::invalid_argument("coverage_limits_invalid");
  }
  bool Plan(const SearchCoverageScope& scope,int64_t ms,int64_t expiry,uint64_t token,bool probe=false) {
    if(!token||pending_.contains(token)||pending_.size()>=kSearchSamplingMetadataPendingLimit)return false;
    auto* w=WindowFor(scope,ms,expiry);
    if(!w){pending_.emplace(token,Obligation{0,probe,scope});++untracked_;return false;}
    if(w->ended_ms>=ms)return false;
    ++w->planned;pending_.emplace(token,Obligation{w->id,probe,scope});return true;
  }
  void Resolve(uint64_t token,Outcome outcome,GapCause failure=GapCause::FailedWrite) {
    const auto p=pending_.find(token);if(p==pending_.end())return;
    if(outcome==Outcome::Unknown)return;
    const auto i=windows_.find(p->second.id);if(i==windows_.end()){pending_.erase(p);return;}
    auto& w=i->second;
    if(outcome==Outcome::NoChange&&!p->second.probe)return;
    // Deferred: admission pressure, not evidence of loss; the owner keeps the owed obligation.
    if(outcome==Outcome::Committed)++w.committed;
    else if(outcome==Outcome::Failed)MarkGap(w,failure);
    ++w.completed;pending_.erase(p);Changed(w);
  }
  // Called ONCE after all offers from this immutable result, including no-target
  // frames. A no-due normal frame does not create a missing-sample obligation.
  bool EndFrame(const SearchCoverageScope& scope,int64_t ms,int64_t expiry,
      std::optional<int64_t> continuous_from={}) {
    auto* w=WindowFor(scope,ms,expiry);if(!w)return false;
    // Only the next trusted consecutive frame may bridge a window boundary.
    // Extend the NEW, unpublished range; never mutate an already sent ID.
    if(continuous_from&&*continuous_from>=0&&*continuous_from<ms&&ms-*continuous_from<1000&&w->range.from_ms==ms)
      w->range.from_ms=*continuous_from;
    w->ended_ms=ms;
    // An unresolved write from an older window cannot certify this later one.
    for(const auto& [token,obligation]:pending_){(void)token;
      if(obligation.id!=w->id&&Same(obligation.scope,scope))MarkGap(*w,GapCause::CrossWindowPending);}
    return true;
  }
  void Gap(const SearchCoverageScope& scope,int64_t ms,int64_t expiry,GapCause cause=GapCause::Unspecified) {
    if(auto* w=WindowFor(scope,ms,expiry)){MarkGap(*w,cause);Changed(*w);}
  }
  void Seal(const std::string& processor,uint64_t generation) {
    for(auto& [id,w]:windows_)if(w.range.scope.source.processor_id==processor&&w.range.scope.generation==generation){
      if(w.closed&&StateOf(w)==SearchCoverageRange::State::Sampled)continue;
      MarkGap(w,GapCause::Seal);w.closed=true;w.range.to_ms=w.last_ms+1;Changed(w);}
    for(auto i=pending_.begin();i!=pending_.end();){auto w=windows_.find(i->second.id);
      if(i->second.scope.source.processor_id==processor&&i->second.scope.generation==generation){
        if(w!=windows_.end())++w->second.completed;
        i=pending_.erase(i);}else ++i;}
  }
  void SealAll(bool release_obligations=true) {
    for(auto& [id,w]:windows_){(void)id;if(w.closed&&StateOf(w)==SearchCoverageRange::State::Sampled)continue;
      MarkGap(w,GapCause::Seal);w.closed=true;w.range.to_ms=w.last_ms+1;Changed(w);}
    if(release_obligations)pending_.clear();
  }
  std::optional<Report> Next(int64_t now_ms) {
    // Expired metadata cannot be published; deleting it does not invent coverage.
    for(auto i=windows_.begin();i!=windows_.end();){
      if(i->second.range.expires_ms<=now_ms){i=windows_.erase(i);}else ++i;}
    for(auto& [id,w]:windows_){(void)id;
      if(!w.closed&&now_ms>=w.range.from_ms&&now_ms-w.range.from_ms>=window_ms_){
        w.closed=true;w.range.to_ms=w.last_ms+1;
        if(w.ended_ms!=w.last_ms)MarkGap(w,GapCause::LastFrameNoEnd);
        Changed(w);
      }
    }
    auto i=windows_.upper_bound(cursor_);
    for(size_t count=0;count<windows_.size();++count){
      if(i==windows_.end())i=windows_.begin();
      auto& w=i->second;
      if(w.closed&&!w.running&&w.version!=w.reported_version){
        cursor_=i->first;Merge(w);w.range.state=StateOf(w);
        switch(w.range.state){case SearchCoverageRange::State::Sampled:++stats_.reported_sampled;break;
          case SearchCoverageRange::State::Gap:++stats_.reported_gap;break;default:++stats_.reported_pending;}
        w.running=true;w.dispatched=true;return Report{i->first,w.version,w.range};}
      ++i;
    }
    return {};
  }
  void Reported(Id id,uint64_t version,bool acknowledged) {
    const auto i=windows_.find(id);if(i==windows_.end())return;
    auto& w=i->second;w.running=false;
    if(!acknowledged)return;
    w.reported_version=version;
    if(version==w.version&&StateOf(w)!=SearchCoverageRange::State::Pending)windows_.erase(i);
  }
  size_t Size()const{return windows_.size();}
  size_t Pending()const{return pending_.size();}
  size_t Dropped()const{return dropped_;}
  size_t Untracked()const{return untracked_;}
  void Abandon(Id id){windows_.erase(id);}
 private:
  struct Window {Id id=0;SearchCoverageRange range;int64_t last_ms=0,ended_ms=-1;
    size_t planned=0,completed=0,committed=0;bool gap=false,closed=false,running=false,dispatched=false;
    uint64_t version=1,reported_version=0;};
  static bool Same(const SearchCoverageScope& a,const SearchCoverageScope& b) {
    return a.source.processor_id==b.source.processor_id&&a.generation==b.generation&&a.scene==b.scene&&
      a.stream_session_id==b.stream_session_id&&a.model_version==b.model_version&&a.package_id==b.package_id&&
      a.source.input_stream_id==b.source.input_stream_id&&a.source.channel_id==b.source.channel_id&&
      a.source.recording_channel_id==b.source.recording_channel_id&&a.source.input_path==b.source.input_path&&a.source.output_path==b.source.output_path;
  }
  static SearchCoverageRange::State StateOf(const Window& w) {
    if(w.gap)return SearchCoverageRange::State::Gap;
    if(w.completed!=w.planned)return SearchCoverageRange::State::Pending;
    return SearchCoverageRange::State::Sampled;
  }
  static void Changed(Window& w){++w.version;}
  Window* WindowFor(const SearchCoverageScope& scope,int64_t ms,int64_t expiry) {
    if(ms<0||ms>=9007199254740991LL||expiry<=ms||expiry>9007199254740991LL)return nullptr;
    Window* active=nullptr;size_t count=0;
    for(auto& [id,w]:windows_){(void)id;
      if(w.range.scope.source.processor_id==scope.source.processor_id&&w.range.scope.scene==scope.scene)++count;
      if(Same(w.range.scope,scope)&&!w.closed)active=&w;}
    if(active){
      if(ms<active->last_ms)return nullptr;
      if(ms-active->range.from_ms<window_ms_){active->last_ms=ms;return active;}
      active->closed=true;active->range.to_ms=active->last_ms+1;
      if(active->ended_ms!=active->last_ms)MarkGap(*active,GapCause::LastFrameNoEnd);
      Changed(*active);
    }
    if(next_==UINT64_MAX)return nullptr;
    if(windows_.size()>=maximum_||count>=per_kind_){
      // Coverage metadata is optional. Drop the oldest unsent closed range,
      // leaving it unknown, rather than rejecting real sample admission.
      auto old=windows_.end();
      for(auto i=windows_.begin();i!=windows_.end();++i){const auto& candidate=i->second;
        if(!candidate.closed||candidate.running)continue;
        if(count>=per_kind_&&(candidate.range.scope.source.processor_id!=scope.source.processor_id||
            candidate.range.scope.scene!=scope.scene))continue;
        old=i;break;}
      if(old==windows_.end())return nullptr;
      // Keep unresolved token/scope obligations even after dropping their
      // window. They prevent later windows from falsely certifying success.
      windows_.erase(old);++dropped_;
    }
    Window w;w.id=next_++;w.range={scope,ms,ms+1,expiry,SearchCoverageRange::State::Pending};w.last_ms=ms;
    return &windows_.emplace(w.id,std::move(w)).first->second;
  }
  size_t maximum_,per_kind_;int64_t window_ms_;Id next_=1,cursor_=0;GapStats stats_;
  void MarkGap(Window& w,GapCause cause){
    const auto c=size_t(cause);++stats_.events[c];
    if(!w.gap){w.gap=true;++stats_.windows[c];}
  }
  void Merge(Window& w){
    if(w.dispatched||StateOf(w)==SearchCoverageRange::State::Pending)return;
    bool joined=true;
    while(joined){joined=false;
      for(auto i=windows_.begin();i!=windows_.end();++i){auto& next=i->second;
        if(next.id==w.id||!next.closed||next.running||next.dispatched||
            !Same(w.range.scope,next.range.scope)||StateOf(next)!=StateOf(w)||
            w.range.to_ms!=next.range.from_ms||next.range.to_ms-w.range.from_ms>60000)continue;
        w.range.to_ms=next.range.to_ms;w.last_ms=next.last_ms;w.ended_ms=next.ended_ms;
        w.range.expires_ms=std::min(w.range.expires_ms,next.range.expires_ms);
        w.planned+=next.planned;w.completed+=next.completed;w.committed+=next.committed;
        for(auto& [token,obligation]:pending_){(void)token;if(obligation.id==next.id)obligation.id=w.id;}
        Changed(w);windows_.erase(i);joined=true;break;
      }
    }
  }
  size_t dropped_=0,untracked_=0;
  struct Obligation {Id id;bool probe;SearchCoverageScope scope;};
  std::map<Id,Window>windows_;std::map<uint64_t,Obligation>pending_;
};
} // namespace ai_service::output

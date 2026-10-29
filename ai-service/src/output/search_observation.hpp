// AINVR. Metadata proof of configured observation scheduling, not analysis of
// every captured video frame. Evidence UUIDs retain the original capture index.
#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <limits>
namespace ai_service::output {
// Why the scheduler had to break observation continuity. Diagnostics only.
enum class SearchObservationGapReason : size_t {
  Cadence, Reset, ExpiredQueuedFrame, ArchiveSkip, FullFrameDrop, LateDeadline,
  NoFrameDeadlineMiss, InferenceError, Count };
inline constexpr const char* SearchObservationGapReasonName(SearchObservationGapReason r) noexcept {
  switch(r){
    case SearchObservationGapReason::Cadence:return "cadence_changed";
    case SearchObservationGapReason::Reset:return "deadline_reset";
    case SearchObservationGapReason::ExpiredQueuedFrame:return "expired_queued_frame";
    case SearchObservationGapReason::ArchiveSkip:return "archive_admission_skip";
    case SearchObservationGapReason::FullFrameDrop:return "full_frame_drop";
    case SearchObservationGapReason::LateDeadline:return "late_whole_slot";
    case SearchObservationGapReason::NoFrameDeadlineMiss:return "no_frame_deadline_miss";
    case SearchObservationGapReason::InferenceError:return "inference_error";
    default:return "unknown";}
}
// Process-wide monotonic counters (all channels): gaps by reason, plus dispatched slots.
struct SearchObservationGapCounters {
  std::array<std::atomic<uint64_t>,size_t(SearchObservationGapReason::Count)> gaps{};
  // Scheduling pressure: a planned slot was lost but no dispatched slot was. Not a gap by itself.
  std::array<std::atomic<uint64_t>,size_t(SearchObservationGapReason::Count)> slips{};
  std::atomic<uint64_t> dispatched{0};
};
inline SearchObservationGapCounters& SearchObservationCounters() noexcept {
  static SearchObservationGapCounters counters;return counters;
}
struct SearchObservationTicket {
  uint64_t ordinal=0,gap_epoch=0;
};
inline bool AdjacentSearchObservations(const SearchObservationTicket& previous,
    const SearchObservationTicket& current) noexcept {
  return previous.ordinal&&current.ordinal&&previous.gap_epoch&&
    previous.gap_epoch==current.gap_epoch&&previous.ordinal<UINT64_MAX&&
    current.ordinal==previous.ordinal+1;
}
// Inference-thread only. Allocate BEFORE SDK dispatch, carrying the ticket
// through pipelined futures. Failed or unpublished work never recycles a slot.
class SearchObservationClock {
 public:
  void Gap(SearchObservationGapReason reason) noexcept {
    SearchObservationCounters().gaps[size_t(reason)].fetch_add(1,std::memory_order_relaxed);
    if(epoch_<UINT64_MAX)++epoch_;
  }
  // Pressure (late/expired/no frame/archive backpressure): counted, ordinals and epoch untouched.
  // Dispatched neighbours stay adjacent; the owner still demands PTS and wall deltas <= 1 s.
  void Slip(SearchObservationGapReason reason) noexcept {
    SearchObservationCounters().slips[size_t(reason)].fetch_add(1,std::memory_order_relaxed);
  }
  void Cadence(double interval) noexcept {
    if(interval_>=0&&interval_!=interval)Gap(SearchObservationGapReason::Cadence);
    interval_=interval;
  }
  SearchObservationTicket Dispatch(double now,double scheduled,double interval) noexcept {
    // Being late by a whole configured slot is a lost planned observation.
    // Ordinary sub-slot jitter and deliberate input downsampling are allowed.
    if(interval>0&&scheduled>0&&now-scheduled>=interval)Slip(SearchObservationGapReason::LateDeadline);
    SearchObservationCounters().dispatched.fetch_add(1,std::memory_order_relaxed);
    if(ordinal_<UINT64_MAX)++ordinal_;
    return {ordinal_,epoch_};
  }
 private:
  uint64_t ordinal_=0,epoch_=1;
  double interval_=-1;
};
} // namespace ai_service::output

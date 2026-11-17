// Copyright AINVR.
#pragma once
#include <cstdint>

namespace ai_service::pipeline {

// Decides whether the AI waits for archive capacity before the next frame.
//
// Slow storage is waited for: that lowers the AI rate and never discards a frame
// that could be stored. Storage that accepts nothing for `stall_seconds` is not
// slow but unavailable; waiting longer would stop recognition and alarms, so the
// worker keeps recognizing without storing and the unstored stretch is reported
// as a gap. Each later frame polls without waiting; storing resumes as soon as
// capacity returns, and the gap length is reported once.
class ArchiveAdmissionGate {
 public:
  enum class Step { Archive, EnterBypass, Skip, Recovered };

  explicit ArchiveAdmissionGate(double stall_seconds) : stall_(stall_seconds) {}

  // Seconds the worker may wait for capacity before reporting.
  double WaitBudget() const { return bypass_ ? 0.0 : stall_; }

  // got_capacity: capacity was available when the wait ended.
  // waited_seconds: how long this wait lasted. now: monotonic seconds.
  // Archive and Recovered store the frame; EnterBypass and Skip do not.
  Step Report(bool got_capacity, double waited_seconds, double now) {
    if (!bypass_) {
      if (got_capacity) return Step::Archive;
      bypass_ = true;
      since_ = now - waited_seconds;
      ++skipped_;
      return Step::EnterBypass;
    }
    if (got_capacity) {
      bypass_ = false;
      last_gap_ = now - since_;
      return Step::Recovered;
    }
    ++skipped_;
    return Step::Skip;
  }

  bool bypassing() const { return bypass_; }
  double since() const { return since_; }
  double last_gap_seconds() const { return last_gap_; }
  int64_t skipped() const { return skipped_; }

 private:
  double stall_;
  bool bypass_ = false;
  double since_ = 0.0, last_gap_ = 0.0;
  int64_t skipped_ = 0;
};

}  // namespace ai_service::pipeline

// Storage that is slow lowers the AI rate (wait, never discard). Storage that stops
// accepting must not stop the AI: past a bounded stall the worker keeps recognizing,
// marks the unstored stretch as a gap, and resumes storing as soon as space returns.
#include <gtest/gtest.h>
#include "../../src/pipeline/archive_admission_gate.hpp"

using ai_service::pipeline::ArchiveAdmissionGate;
using Step = ArchiveAdmissionGate::Step;

TEST(ArchiveAdmissionGate, SlowStorageIsWaitedForUpToTheStallBound) {
  ArchiveAdmissionGate gate(10.0);
  EXPECT_DOUBLE_EQ(gate.WaitBudget(), 10.0);  // archiving: wait, lowering the rate
  EXPECT_EQ(gate.Report(true, 3.0, 100.0), Step::Archive);
  EXPECT_FALSE(gate.bypassing());
}

TEST(ArchiveAdmissionGate, StalledStorageBypassesArchivingAndPollsWithoutWaiting) {
  ArchiveAdmissionGate gate(10.0);
  EXPECT_EQ(gate.Report(false, 10.0, 100.0), Step::EnterBypass);
  EXPECT_TRUE(gate.bypassing());
  EXPECT_DOUBLE_EQ(gate.since(), 90.0);           // the gap starts when the wait began
  EXPECT_DOUBLE_EQ(gate.WaitBudget(), 0.0);       // later frames never wait again
  EXPECT_EQ(gate.Report(false, 0.0, 101.0), Step::Skip);
  EXPECT_EQ(gate.Report(false, 0.0, 102.0), Step::Skip);
  EXPECT_EQ(gate.skipped(), 3);                   // the stalled frame and both later ones
}

TEST(ArchiveAdmissionGate, CapacityReturningEndsTheGapAndReportsItsLength) {
  ArchiveAdmissionGate gate(10.0);
  gate.Report(false, 10.0, 100.0);
  gate.Report(false, 0.0, 130.0);
  EXPECT_EQ(gate.Report(true, 0.0, 160.0), Step::Recovered);
  EXPECT_DOUBLE_EQ(gate.last_gap_seconds(), 70.0);
  EXPECT_FALSE(gate.bypassing());
  EXPECT_DOUBLE_EQ(gate.WaitBudget(), 10.0);
  EXPECT_EQ(gate.Report(true, 0.5, 161.0), Step::Archive);
}

TEST(ArchiveAdmissionGate, AShortWaitThatSucceedsNeverBypasses) {
  ArchiveAdmissionGate gate(10.0);
  for (int i = 0; i < 100; ++i) EXPECT_EQ(gate.Report(true, 9.9, 100.0 + i), Step::Archive);
  EXPECT_EQ(gate.skipped(), 0);
}

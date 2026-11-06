#pragma once
namespace ai_service::api {
// Called on control-loop exit. Closing the listener must not be skipped if
// draining a channel throws; the main thread still performs its final cleanup.
template<class StopChannels, class StopListener>
bool StopControlPlane(StopChannels stop_channels, StopListener stop_listener) noexcept {
  bool drained = true;
  try { stop_channels(); } catch (...) { drained = false; }
  try { stop_listener(); } catch (...) { drained = false; }
  return drained;
}
// Do not feed the watchdog during recovery: an SDK drain may hang while HTTP
// remains responsive. The configured supervisor bounds this failure mode.
inline bool ControlPlaneMayHeartbeat(bool recovery, bool listening, bool hardware_healthy) noexcept {
  return !recovery && listening && hardware_healthy;
}
inline int ControlExitCode(bool recovery, bool listened, bool drained) noexcept {
  if (!drained) return 1;
  return recovery ? 75 : listened ? 0 : 1;
}
}

// Copyright AINVR. State names shared with the original control protocol.
#include "managed_worker.hpp"
namespace ai_service::pipeline {
std::string ToString(ChannelState state) {
  switch (state) {
    case ChannelState::kIdle: return "idle";
    case ChannelState::kStarting: return "starting";
    case ChannelState::kRunning: return "running";
    case ChannelState::kError: return "error";
    case ChannelState::kStopping: return "stopping";
    case ChannelState::kReconnecting: return "reconnecting";
  }
  return "error";
}
}

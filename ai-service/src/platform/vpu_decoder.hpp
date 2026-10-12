// Copyright AINVR. Independent submission/retrieval permits B-frame reordering.
#pragma once
#include <cstdint>
#include <memory>
#include <optional>
#include <vector>
namespace ainvr {
enum class Codec { H264, H265, Jpeg, Mjpeg };
struct Nv12Frame {
  int width=0,height=0;
  uint64_t pts=0; // Caller-defined timestamp units, passed through SDK unchanged.
  std::vector<uint8_t> pixels; // Packed Y then interleaved UV; explicit copy.
};
class VpuDecoder {
 public:
  VpuDecoder(Codec codec,int maximum_width,int maximum_height);
  ~VpuDecoder();
  VpuDecoder(const VpuDecoder&)=delete;
  VpuDecoder& operator=(const VpuDecoder&)=delete;
  // A complete Annex-B access unit (or one JPEG), not arbitrary byte chunks.
  // On timeout returns false; callers retain and retry the same packet.
  bool Submit(const std::vector<uint8_t>& access_unit,uint64_t pts,int timeout_ms=100);
  bool Finish(int timeout_ms=100);
  std::optional<Nv12Frame> Receive(int timeout_ms=100);
 private:
  struct State;std::unique_ptr<State> state_;
};
}

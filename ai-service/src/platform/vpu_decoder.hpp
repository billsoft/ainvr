// Copyright AINVR. Independent submission/retrieval permits B-frame reordering.
#pragma once
#include <cstdint>
#include <memory>
#include <optional>
#include <vector>
namespace ainvr {
enum class Codec { H264, H265, Jpeg, Mjpeg };
// Opt-in only for JPEG consumers which explicitly crop visible pixels on GPU.
// Ordinary video and strict JPEG callers retain their previous even contract.
enum class JpegOutputLayout { StrictVisible, EvenPaddedSurface };
struct Nv12Frame {
  int width=0,height=0;
  uint64_t pts=0; // Caller-defined timestamp units, passed through SDK unchanged.
  std::vector<uint8_t> pixels; // Packed Y then interleaved UV; explicit copy.
  int visible_width=0,visible_height=0; // Exact JPEG display dimensions, never MCU allocation.
};
class VpuDecoder {
 public:
  VpuDecoder(Codec codec,int maximum_width,int maximum_height,
             JpegOutputLayout jpeg_layout=JpegOutputLayout::StrictVisible);
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

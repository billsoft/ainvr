// Copyright AINVR.
#pragma once
#include <cstdint>
#include <memory>
#include <vector>
namespace ainvr {
class JpegEncoder {
 public:
  // Even visible dimensions 18..8192. Internally edge-padded to SDK alignment;
  // baseline 4:2:0 JPEG retains the requested visible width and height.
  // Optional visible size may remove an edge-padded row/column only while
  // preserving the 16x16 MCU grid. JPEG header changes do not recompress pixels.
  JpegEncoder(int width,int height,int quality=90,int visible_width=0,int visible_height=0);
  ~JpegEncoder();
  JpegEncoder(const JpegEncoder&)=delete;
  JpegEncoder& operator=(const JpegEncoder&)=delete;
  // Packed FULL-RANGE BT.601/JPEG NV12. Limited-range video must be converted
  // before calling; this interface never silently relabels video color values.
  // Calls are serialized. SDK failure poisons the instance; recreate to retry.
  std::vector<uint8_t> EncodeFullRangeNv12(const std::vector<uint8_t>& pixels,
      int visible_width=0,int visible_height=0);
 private:
  struct State;std::unique_ptr<State> state_;
};
}

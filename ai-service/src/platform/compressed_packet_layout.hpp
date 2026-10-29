// Copyright AINVR. SDK-independent compressed packet submission bounds.
#pragma once
#include "vpu_decoder.hpp"
#include <algorithm>
#include <cstddef>
#include <stdexcept>
namespace ainvr {
inline std::size_t DecoderQueuedPacketBytes(Codec codec,std::size_t bytes,
    std::size_t capacity,bool end_of_stream){
  if((!bytes&&!end_of_stream)||bytes>capacity)
    throw std::invalid_argument("Invalid access unit size");
  // S100P's frame-size JPEG decoder rejects otherwise valid packets shorter
  // than 1 KiB. Pad only the SDK submission after EOI, never stored evidence.
  // JPEG dimensions, entropy data, caller timestamps and video AUs are intact.
  const bool jpeg=codec==Codec::Jpeg||codec==Codec::Mjpeg;
  const auto queued=jpeg&&!end_of_stream?std::max<std::size_t>(bytes,1024):bytes;
  if(queued>capacity)throw std::invalid_argument("Invalid access unit size");
  return queued;
}
} // namespace ainvr

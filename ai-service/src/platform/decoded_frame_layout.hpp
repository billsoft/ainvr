// Copyright AINVR. SDK-independent decoded NV12 layout validation only.
#pragma once
#include "vpu_decoder.hpp"
#include <array>
#include <cstdint>
#include <stdexcept>
namespace ainvr {
struct DecodedNv12Layout {
  int buffer_width=0,buffer_height=0,luma_stride=0,chroma_stride=0;
  uint64_t total_bytes=0;
  std::array<uint64_t,2> plane_bytes{};
  bool luma_present=false,chroma_present=false,nv12=false;
  int display_width=0,display_height=0,jpeg_decode_result=0;
};
struct VisibleNv12Layout { int width,height,luma_stride,chroma_stride,visible_width,visible_height; };
inline VisibleNv12Layout ValidateDecodedNv12Layout(Codec codec,const DecodedNv12Layout& input,int maximum_width,int maximum_height,
    JpegOutputLayout jpeg_layout=JpegOutputLayout::StrictVisible){
  const bool jpeg=codec==Codec::Jpeg||codec==Codec::Mjpeg;
  if(jpeg&&input.jpeg_decode_result!=1)
    throw std::runtime_error("JPEG decoder reported damaged or unsupported image");
  const auto invalid=[] {throw std::runtime_error("Unsupported decoded frame layout/resolution change");};
  const int width=jpeg?input.display_width:input.buffer_width;
  const int height=jpeg?input.display_height:input.buffer_height;
  const int ys=input.luma_stride>0?input.luma_stride:input.buffer_width;
  const int uvs=input.chroma_stride>0?input.chroma_stride:ys;
  const bool padded=jpeg&&jpeg_layout==JpegOutputLayout::EvenPaddedSurface;
  if(width<=0||height<=0||(!padded&&(width%2||height%2))||width>maximum_width||height>maximum_height||
      ys<width||uvs<width||!input.luma_present||!input.chroma_present)invalid();
  if(jpeg){
    // SDK JPEG outputs can pad their allocation independently of the visible
    // display dimensions. Neither padding nor strides are frame coordinates.
    if(!input.nv12||input.buffer_width<=0||input.buffer_height<=0||input.buffer_width%2||input.buffer_height%2||
        width>input.buffer_width||height>input.buffer_height||input.luma_stride<input.buffer_width||input.chroma_stride<input.buffer_width)invalid();
    const uint64_t y_bytes=uint64_t(input.luma_stride)*uint64_t(input.buffer_height);
    const uint64_t uv_bytes=uint64_t(input.chroma_stride)*uint64_t(input.buffer_height/2);
    if(input.plane_bytes[0]<y_bytes||input.plane_bytes[1]<uv_bytes||
        input.total_bytes<y_bytes+uv_bytes||input.plane_bytes[0]>input.total_bytes||
        input.plane_bytes[1]>input.total_bytes-input.plane_bytes[0])invalid();
  }
  // The video branch intentionally retains its established allocation-size,
  // stride-fallback and max-resolution contract. Its existing POC checks and
  // session/frame timestamp semantics remain in VpuDecoder::Receive.
  const int surface_width=padded?(width+1)/2*2:width,surface_height=padded?(height+1)/2*2:height;
  if(surface_width>maximum_width||surface_height>maximum_height||
      (jpeg&&(surface_width>input.buffer_width||surface_height>input.buffer_height)))invalid();
  return {surface_width,surface_height,ys,uvs,width,height};
}
} // namespace ainvr

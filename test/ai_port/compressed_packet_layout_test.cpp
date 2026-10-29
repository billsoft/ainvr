// Copyright AINVR. Packet boundaries only; no SDK or hardware invocation.
#include "platform/compressed_packet_layout.hpp"
#include <gtest/gtest.h>
#include <limits>
namespace {
TEST(CompressedPacketLayout, JpegAndMjpegRequireMinimumHardwareSubmission){
  for(const auto codec:{ainvr::Codec::Jpeg,ainvr::Codec::Mjpeg}){
    for(const std::size_t size:{1,911,912,960,1000,1023,1024})
      EXPECT_EQ(ainvr::DecoderQueuedPacketBytes(codec,size,4096,false),1024U);
    for(const std::size_t size:{1025,1088,4096})
      EXPECT_EQ(ainvr::DecoderQueuedPacketBytes(codec,size,4096,false),size);
  }
}
TEST(CompressedPacketLayout, VideoAccessUnitsAndEndOfStreamAreUnchanged){
  for(const auto codec:{ainvr::Codec::H264,ainvr::Codec::H265})
    for(const std::size_t size:{1,911,1023,1024,4096})
      EXPECT_EQ(ainvr::DecoderQueuedPacketBytes(codec,size,4096,false),size);
  for(const auto codec:{ainvr::Codec::H264,ainvr::Codec::H265,ainvr::Codec::Jpeg,ainvr::Codec::Mjpeg})
    EXPECT_EQ(ainvr::DecoderQueuedPacketBytes(codec,0,4096,true),0U);
}
TEST(CompressedPacketLayout, RejectsEmptyOverflowAndInsufficientSdkCapacity){
  for(const auto codec:{ainvr::Codec::H264,ainvr::Codec::H265,ainvr::Codec::Jpeg,ainvr::Codec::Mjpeg}){
    EXPECT_THROW(ainvr::DecoderQueuedPacketBytes(codec,0,4096,false),std::invalid_argument);
    EXPECT_THROW(ainvr::DecoderQueuedPacketBytes(codec,4097,4096,false),std::invalid_argument);
    EXPECT_THROW(ainvr::DecoderQueuedPacketBytes(codec,std::numeric_limits<std::size_t>::max(),4096,false),std::invalid_argument);
  }
  EXPECT_THROW(ainvr::DecoderQueuedPacketBytes(ainvr::Codec::Jpeg,911,1023,false),std::invalid_argument);
  EXPECT_THROW(ainvr::DecoderQueuedPacketBytes(ainvr::Codec::Mjpeg,1,0,false),std::invalid_argument);
}
} // namespace

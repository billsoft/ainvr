// Copyright AINVR. Exercise real GStreamer timestamp transfer and bounded pressure.
#include "stream/compressed_tap.hpp"
#include <gst/app/gstappsink.h>
#include <gtest/gtest.h>
#include <chrono>
#include <thread>
using namespace ainvr;
TEST(CompressedTap, PreservesBframeOrderNegativeInitialDtsDurationAndBytes){
 CompressedTap tap(Codec::H264);auto* sink=tap.SinkReference();ASSERT_NE(sink,nullptr);
 const int64_t step=33333333;
 for(auto pair:{std::pair<int,int>{-2,0},{-1,3},{0,1},{1,2}}){
  CompressedFrame packet;packet.bytes={0,0,0,1,0x65,uint8_t(pair.second)};
  packet.dts_ns=pair.first*step;packet.pts_ns=pair.second*step;
  packet.duration_ns=step;packet.key_frame=pair.first==-2;
  auto stamp=tap.Feed(packet);ASSERT_TRUE(stamp);
  auto* sample=gst_app_sink_try_pull_sample(GST_APP_SINK(sink),GST_SECOND);ASSERT_NE(sample,nullptr);
  auto* buffer=gst_sample_get_buffer(sample);
  EXPECT_EQ(GST_BUFFER_DTS(buffer),(pair.first+2)*step);
  EXPECT_EQ(GST_BUFFER_PTS(buffer),(pair.second+2)*step);
  EXPECT_EQ(stamp->pts_ns,GST_BUFFER_PTS(buffer));EXPECT_EQ(stamp->dts_ns,GST_BUFFER_DTS(buffer));
  EXPECT_EQ(GST_BUFFER_DURATION(buffer),step);
  EXPECT_EQ(!GST_BUFFER_FLAG_IS_SET(buffer,GST_BUFFER_FLAG_DELTA_UNIT),packet.key_frame);
  std::vector<uint8_t> bytes(gst_buffer_get_size(buffer));gst_buffer_extract(buffer,0,bytes.data(),bytes.size());
  EXPECT_EQ(bytes,packet.bytes);gst_sample_unref(sample);
 }
 gst_object_unref(sink);tap.Stop();EXPECT_EQ(tap.SinkReference(),nullptr);
 EXPECT_THROW(tap.Feed(CompressedFrame{}),std::runtime_error);
}
TEST(CompressedTap, BoundedBackpressureCanResumeWithoutDroppingOrAdvancingClock){
 CompressedTap tap(Codec::H264,1024);CompressedFrame packet;
 packet.bytes=std::vector<uint8_t>(512,0x55);packet.duration_ns=33333333;
 int count=0;bool pressure=false;
 for(int i=0;i<100;++i){packet.dts_ns=i*packet.duration_ns;packet.pts_ns=packet.dts_ns;
  if(!tap.Feed(packet)){pressure=true;break;}++count;}
 ASSERT_TRUE(pressure);EXPECT_LE(count,20);
 auto* sink=tap.SinkReference();
 for(int i=0;i<count;++i){auto* sample=gst_app_sink_try_pull_sample(GST_APP_SINK(sink),GST_SECOND);
  ASSERT_NE(sample,nullptr);EXPECT_EQ(GST_BUFFER_DTS(gst_sample_get_buffer(sample)),i*packet.duration_ns);
  gst_sample_unref(sample);}
 auto stamp=tap.Feed(packet);ASSERT_TRUE(stamp);
 EXPECT_EQ(stamp->dts_ns,count*packet.duration_ns);gst_object_unref(sink);
}
TEST(CompressedTap, RejectsUnsupportedCodecAndBadStorage){
 EXPECT_THROW(CompressedTap(Codec::Jpeg),std::invalid_argument);
 CompressedTap tap(Codec::H264,1024);CompressedFrame packet;
 EXPECT_THROW(tap.Feed(packet),std::invalid_argument);
 packet.bytes.resize(1025);EXPECT_THROW(tap.Feed(packet),std::invalid_argument);
 packet.bytes.resize(12);packet.duration_ns=-1;EXPECT_THROW(tap.Feed(packet),std::invalid_argument);
}

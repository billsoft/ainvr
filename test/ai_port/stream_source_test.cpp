// Copyright AINVR. Hardware source contract, real VPU; CPU fixtures are test-only.
#include "stream/source.hpp"
#include <gtest/gtest.h>
#include <gst/app/gstappsink.h>
#include <chrono>
#include <cstdlib>
#include <future>
#include <fstream>
#include <map>
#include <set>
#include <thread>
using namespace ai_service::stream;
using Clock=std::chrono::steady_clock;
namespace {
std::string Env(const char* key){
  auto value=std::getenv(key);if(!value||!*value)throw std::runtime_error(std::string("Missing required test fixture: ")+key);
  return value;
}
struct Packet {int64_t pts,dts;std::vector<uint8_t> bytes;bool key;};
struct SampleRef {GstSample* value=nullptr;~SampleRef(){if(value)gst_sample_unref(value);}};
struct ElementRef {GstElement* value=nullptr;~ElementRef(){if(value)gst_object_unref(value);}};
std::optional<Packet> ReadPacket(GstElement* sink,int ms){
  SampleRef sample{gst_app_sink_try_pull_sample(GST_APP_SINK(sink),uint64_t(ms)*GST_MSECOND)};
  if(!sample.value)return std::nullopt;
  auto b=gst_sample_get_buffer(sample.value);GstMapInfo map{};
  if(!gst_buffer_map(b,&map,GST_MAP_READ))throw std::runtime_error("Cannot inspect test compressed sample");
  Packet p{int64_t(GST_BUFFER_PTS(b)),int64_t(GST_BUFFER_DTS(b)),
    std::vector<uint8_t>(map.data,map.data+map.size),!GST_BUFFER_FLAG_IS_SET(b,GST_BUFFER_FLAG_DELTA_UNIT)};
  gst_buffer_unmap(b,&map);return p;
}
std::vector<Packet> ReferencePackets(const std::string& file){
  ainvr::MediaSource source(file);PtsRebaser clock;std::vector<Packet> result;
  bool started=false;
  while(auto p=source.Read()){
    if(!started){if(!p->key_frame)continue;started=true;}
    auto [dts,pts]=clock.Map(p->dts_ns,p->pts_ns);
    result.push_back({pts,dts,p->bytes,p->key_frame});
  }
  return result;
}
std::vector<std::shared_ptr<FrameRef>> ReadFrames(StreamSource& source,int max,int seconds=10){
  auto deadline=Clock::now()+std::chrono::seconds(seconds);
  std::vector<std::shared_ptr<FrameRef>> result;
  while(Clock::now()<deadline&&int(result.size())<max){
    if(auto f=source.PullFrameRef(100))result.push_back(std::move(f));
    else if(!source.IsRunning())break;
  }
  return result;
}
void VerifyFile(const char* env,VideoCodec expected_codec){
  const auto file=Env(env);auto expected=ReferencePackets(file);ASSERT_GE(expected.size(),18);
  StreamSource source(file,"fixture",true);source.Start();
  ElementRef sink{source.GetEsSinkRef()};ASSERT_NE(sink.value,nullptr);
  auto packets=std::async(std::launch::async,[&]{
    std::vector<Packet> result;auto deadline=Clock::now()+std::chrono::seconds(10);
    while(Clock::now()<deadline&&result.size()<expected.size()){
      if(auto p=ReadPacket(sink.value,100))result.push_back(std::move(*p));
      else if(!source.IsRunning())break;
    }
    return result;
  });
  auto frames=ReadFrames(source,100);auto actual=packets.get();auto stats=source.GetStats();
  ASSERT_FALSE(stats.error.has_value())<<stats.error.value_or("");
  EXPECT_TRUE(stats.eof);EXPECT_EQ(stats.pending_tokens,0);
  EXPECT_EQ(stats.decoded,expected.size());EXPECT_EQ(actual.size(),expected.size());
  EXPECT_EQ(source.Codec(),expected_codec);EXPECT_EQ(source.GetAuShed(),0);
  ASSERT_GE(frames.size(),5);
  ASSERT_EQ(actual.size(),expected.size());
  std::map<int64_t,int64_t> original_by_mapped;
  ainvr::MediaSource original(file);PtsRebaser clock;
  while(auto p=original.Read()){
    ASSERT_TRUE(p->pts_ns.has_value());auto [dts,pts]=clock.Map(p->dts_ns,p->pts_ns);
    ASSERT_TRUE(original_by_mapped.emplace(pts,*p->pts_ns).second);
  }
  bool saw_reordering=false;
  for(size_t i=0;i<actual.size();++i){
    EXPECT_EQ(actual[i].pts,expected[i].pts);EXPECT_EQ(actual[i].dts,expected[i].dts);
    EXPECT_EQ(actual[i].bytes,expected[i].bytes);EXPECT_EQ(actual[i].key,expected[i].key);
    if(i&&actual[i].pts<actual[i-1].pts)saw_reordering=true;
  }
  EXPECT_TRUE(saw_reordering)<<"Fixture must contain reordered B pictures";
  for(size_t i=0;i<frames.size();++i){
    const auto& f=*frames[i];ASSERT_TRUE(original_by_mapped.contains(f.pts_ns));
    ASSERT_TRUE(f.source_pts_ns.has_value());EXPECT_EQ(*f.source_pts_ns,original_by_mapped.at(f.pts_ns));
    EXPECT_EQ(f.nv12.pts,uint64_t(f.pts_ns));EXPECT_EQ(f.nv12.pixels.size(),size_t(f.width)*f.height*3/2);
    if(i)EXPECT_GT(f.pts_ns,frames[i-1]->pts_ns);
  }
  source.Stop();
  EXPECT_EQ(stats.decoded,stats.superseded+stats.delivered);
  ::testing::Test::RecordProperty("hardware_decoded_frames",int(stats.decoded));
  ::testing::Test::RecordProperty("matching_compressed_access_units",int(actual.size()));
  ::testing::Test::RecordProperty("observed_display_frames",int(frames.size()));
}
}
TEST(StreamSource,OriginalGopSheddingNeverResumesMidGop){
  GopAwareShedder s;EXPECT_FALSE(s.Decide(true,100,64));
  EXPECT_TRUE(s.Decide(false,64,64));EXPECT_TRUE(s.Decide(false,0,64));
  EXPECT_TRUE(s.shedding());EXPECT_FALSE(s.Decide(true,0,64));
  EXPECT_FALSE(s.Decide(false,0,64));EXPECT_EQ(s.shed_count(),2);
}
TEST(StreamSource,ExternalTapClockKeepsReorderedPtsAndRejectsMixedClockOwnership){
  ainvr::CompressedTap tap(ainvr::Codec::H264);ElementRef sink{tap.SinkReference()};
  ainvr::CompressedFrame p;p.bytes={0,0,0,1,0x65,1,2};p.key_frame=true;p.duration_ns=1;
  ASSERT_TRUE(tap.FeedAt(p,{3,1}));ASSERT_TRUE(tap.FeedAt(p,{2,2}));
  auto a=ReadPacket(sink.value,1000),b=ReadPacket(sink.value,1000);ASSERT_TRUE(a&&b);
  EXPECT_EQ(a->pts,3);EXPECT_EQ(a->dts,1);EXPECT_EQ(b->pts,2);EXPECT_EQ(b->dts,2);
  EXPECT_EQ(a->bytes,p.bytes);EXPECT_EQ(b->bytes,p.bytes);
  EXPECT_THROW(tap.Feed(p),std::logic_error);
  EXPECT_THROW(tap.FeedAt(p,{4,0}),std::invalid_argument);
}
TEST(StreamSource,H264BFramesShareExactOriginalBytesAndDisplayPts){VerifyFile("AINVR_SOURCE_H264",VideoCodec::kH264);}
TEST(StreamSource,JpuStartupPollingAndRepeatedDestructionDecodeRealJpeg){
  std::ifstream file(Env("AINVR_SOURCE_JPEG"),std::ios::binary);
  ASSERT_TRUE(file.good());
  std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
  ASSERT_GT(bytes.size(),100);
  for(int cycle=0;cycle<3;++cycle){
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,640,320);
    EXPECT_FALSE(decoder.Receive(0).has_value());
    ASSERT_TRUE(decoder.Submit(bytes,cycle+1,100));
    std::optional<ainvr::Nv12Frame> frame;
    const auto deadline=Clock::now()+std::chrono::seconds(3);
    while(!frame&&Clock::now()<deadline)frame=decoder.Receive(50);
    ASSERT_TRUE(frame.has_value());
    EXPECT_EQ(frame->width,640);EXPECT_EQ(frame->height,320);
    EXPECT_EQ(frame->pixels.size(),size_t(640)*320*3/2);
    uint64_t sum=0;for(size_t i=0;i<size_t(640)*320;++i)sum+=frame->pixels[i];
    // CPU arithmetic is a test-only sanity oracle for real JPU output.
    const double mean=double(sum)/(640*320);EXPECT_GT(mean,10);EXPECT_LT(mean,245);
  }
  RecordProperty("real_jpu_decoded_frames",3);
}
TEST(StreamSource,H265BFramesShareExactOriginalBytesAndDisplayPts){VerifyFile("AINVR_SOURCE_H265",VideoCodec::kH265);}
TEST(StreamSource,NoPublisherLatestFrameIsBoundedAndReferenceSurvivesRestart){
  StreamSource source(Env("AINVR_SOURCE_LONG"),"latest",false);
  source.Start();EXPECT_EQ(source.GetEsSinkRef(),nullptr);
  auto frames=ReadFrames(source,1);ASSERT_EQ(frames.size(),1);
  const auto held=frames[0];const auto copy=held->nv12.pixels;
  auto gen=source.GetStreamGeneration();
  // Leave the consumer idle; decoded images replace a single latest reference.
  auto deadline=Clock::now()+std::chrono::seconds(10);
  while(source.IsRunning()&&Clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(10));
  EXPECT_FALSE(source.IsRunning());auto stats=source.GetStats();
  EXPECT_TRUE(stats.eof);ASSERT_FALSE(stats.error)<<stats.error.value_or("");
  EXPECT_GE(stats.superseded,100);EXPECT_EQ(stats.pending_tokens,0);
  source.Stop();EXPECT_GT(source.GetStreamGeneration(),gen);
  EXPECT_EQ(held->nv12.pixels,copy);EXPECT_EQ(source.PullFrameRef(0),nullptr);
  source.Start();auto fresh=ReadFrames(source,1);ASSERT_EQ(fresh.size(),1);
  EXPECT_GT(source.GetStreamGeneration(),gen);EXPECT_EQ(held->nv12.pixels,copy);
  source.Stop();EXPECT_EQ(source.GetEsSinkRef(),nullptr);
}
TEST(StreamSource,FullCompressedTapStopIsBoundedAndOldSinkReferenceIsSafe){
  StreamSource source(Env("AINVR_SOURCE_LONG"),"tap-stop",true);
  source.Start();ElementRef old{source.GetEsSinkRef()};ASSERT_NE(old.value,nullptr);
  auto deadline=Clock::now()+std::chrono::seconds(10);EsQueueDiag diag;
  do{diag=source.GetEsQueueDiag();if(diag.current_level_buffers>=64)break;
    std::this_thread::sleep_for(std::chrono::milliseconds(5));}while(Clock::now()<deadline);
  ASSERT_GE(diag.current_level_buffers,64);ASSERT_TRUE(source.IsRunning());
  auto gen=source.GetStreamGeneration();auto start=Clock::now();source.Stop();
  double elapsed=std::chrono::duration<double,std::milli>(Clock::now()-start).count();
  EXPECT_LT(elapsed,1200);EXPECT_GT(source.GetStreamGeneration(),gen);
  EXPECT_EQ(source.GetEsSinkRef(),nullptr);EXPECT_FALSE(source.GetStats().error);
  EXPECT_FALSE(ReadPacket(old.value,0).has_value());
  RecordProperty("stop_from_full_tap_ms",elapsed);
}
TEST(StreamSource,Live4KStopAndRestartKeepDetachedFramesAndGeneration){
  StreamSource source(Env("AINVR_SOURCE_LIVE"),"live-read-only",false,3000);
  std::shared_ptr<FrameRef> held;std::vector<uint8_t> pixels;int observed=0;
  int64_t gen=source.GetStreamGeneration();
  for(int cycle=0;cycle<3;++cycle){
    source.Start();EXPECT_GT(source.GetStreamGeneration(),gen);gen=source.GetStreamGeneration();
    auto frames=ReadFrames(source,4,8);ASSERT_EQ(frames.size(),4);
    for(auto& f:frames){EXPECT_EQ(f->width,3840);EXPECT_EQ(f->height,1920);EXPECT_GE(f->pts_ns,0);++observed;}
    if(!held){held=frames[0];pixels=held->nv12.pixels;}
    auto begin=Clock::now();source.Stop();
    const double stop_ms=std::chrono::duration<double,std::milli>(Clock::now()-begin).count();
    EXPECT_LT(stop_ms,1200);
    EXPECT_GT(source.GetStreamGeneration(),gen);gen=source.GetStreamGeneration();
    EXPECT_EQ(held->nv12.pixels,pixels);EXPECT_EQ(source.GetStats().pending_tokens,0);
  }
  RecordProperty("real_4k_frames",observed);
}
TEST(StreamSource,StalledOpenFailsWithinTimeoutAndDoesNotLeakCredentials){
  StreamSource source(Env("AINVR_SOURCE_STALL"),"stall",false,500);
  std::string error;source.SetErrorCallback([&](const std::string& e){error=e;});
  auto begin=Clock::now();EXPECT_THROW(source.Start(),std::runtime_error);
  EXPECT_LT(std::chrono::duration<double>(Clock::now()-begin).count(),2.5);
  EXPECT_FALSE(source.IsRunning());EXPECT_EQ(source.GetEsSinkRef(),nullptr);
  EXPECT_FALSE(error.empty());EXPECT_EQ(error.find("secret-token"),std::string::npos);
  source.Stop();
}
TEST(StreamSource,InvalidInputsDoNotStartHardwareAndFailedSourceCanRetry){
  EXPECT_THROW(StreamSource("","empty"),std::invalid_argument);
  EXPECT_THROW(StreamSource("file","test",false,99),std::invalid_argument);
  StreamSource source(Env("AINVR_SOURCE_MISSING"),"missing");
  EXPECT_THROW(source.PullFrameRef(-1),std::invalid_argument);
  EXPECT_THROW(source.Start(),std::runtime_error);auto gen=source.GetStreamGeneration();
  EXPECT_THROW(source.Start(),std::runtime_error);EXPECT_GT(source.GetStreamGeneration(),gen);
  EXPECT_EQ(source.GetEsSinkRef(),nullptr);source.Stop();
}

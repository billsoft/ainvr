// Copyright AINVR. Isolated transport metadata, never publishes fake inference on user channels.
#include "stream/source.hpp"
#include "stream/sei.hpp"
#include <gst/gst.h>
#include <openssl/sha.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <unistd.h>
using namespace ainvr;
namespace {
using Clock=std::chrono::steady_clock;
double Mono(){return std::chrono::duration<double>(Clock::now().time_since_epoch()).count();}
std::string Hex(const std::vector<uint8_t>& bytes){std::ostringstream out;out<<std::hex<<std::setfill('0');for(auto b:bytes)out<<std::setw(2)<<int(b);return out.str();}
std::vector<std::vector<uint8_t>> Nals(const std::vector<uint8_t>& bytes){
 auto starts=ai_service::sei::find_annexb_nals(bytes);std::vector<std::vector<uint8_t>> result;
 for(size_t i=0;i<starts.size();++i){size_t start=starts[i].first,end=i+1<starts.size()?starts[i+1].first-starts[i+1].second:bytes.size();
  while(end>start&&bytes[end-1]==0)--end;
  if(end>start)result.emplace_back(bytes.begin()+start,bytes.begin()+end);}
 return result;
}
std::string VclHash(const std::vector<uint8_t>& bytes,ai_service::stream::VideoCodec codec){
 std::vector<uint8_t> vcl;
 for(auto& nal:Nals(bytes))if(ai_service::stream::IsVcl(codec,ai_service::stream::NalType(codec,nal[0]))){
  uint32_t length=nal.size();for(int i=3;i>=0;--i)vcl.push_back(length>>(i*8));vcl.insert(vcl.end(),nal.begin(),nal.end());}
 if(vcl.empty())throw std::runtime_error("Access unit has no VCL payload");
 std::vector<uint8_t> digest(SHA256_DIGEST_LENGTH);SHA256(vcl.data(),vcl.size(),digest.data());return Hex(digest);
}
struct CompressedEvidence {
 std::mutex mutex;std::map<int64_t,std::string> expected;
 ai_service::stream::VideoCodec codec=ai_service::stream::VideoCodec::kH264;
 std::optional<std::string> error;GstPad* pad=nullptr;gulong probe=0;
 ~CompressedEvidence(){if(pad){if(probe)gst_pad_remove_probe(pad,probe);gst_object_unref(pad);}}
 static GstPadProbeReturn Observe(GstPad*,GstPadProbeInfo* info,gpointer data){
  auto& self=*static_cast<CompressedEvidence*>(data);GstMapInfo mapped{};
  auto buffer=GST_PAD_PROBE_INFO_BUFFER(info);
  if(!buffer||!gst_buffer_map(buffer,&mapped,GST_MAP_READ))return GST_PAD_PROBE_OK;
  try{
   auto hash=VclHash(std::vector<uint8_t>(mapped.data,mapped.data+mapped.size),self.codec);
   std::lock_guard lock(self.mutex);
   if(!self.expected.emplace(int64_t(GST_BUFFER_PTS(buffer)),std::move(hash)).second)
    self.error="Duplicate input PTS";
  }catch(const std::exception& e){std::lock_guard lock(self.mutex);self.error=e.what();}
  gst_buffer_unmap(buffer,&mapped);return GST_PAD_PROBE_OK;
 }
};
}
int main(int argc,char** argv){try{
 if(argc!=3)throw std::invalid_argument("Usage: probe input_url new_report.json");
 if(std::filesystem::exists(argv[2]))throw std::runtime_error("Report already exists");
 CompressedEvidence evidence;
 auto& expected_mutex=evidence.mutex;auto& expected=evidence.expected;
 ai_service::stream::StreamSource source(argv[1],"source-sei-test",true,5000);
 source.Start();
 const auto size=source.GetTrueSourceSize();if(!size)throw std::runtime_error("Missing source dimensions");
 const auto codec=source.Codec();evidence.codec=codec;
 struct {int width,height;Codec codec;} info{size->first,size->second,
    codec==ai_service::stream::VideoCodec::kH264?Codec::H264:Codec::H265};
 auto sink=source.GetEsSinkRef();if(!sink)throw std::runtime_error("Missing compressed branch");
 evidence.pad=gst_element_get_static_pad(sink,"sink");gst_object_unref(sink);
 if(!evidence.pad)throw std::runtime_error("Missing compressed sink pad");
 evidence.probe=gst_pad_add_probe(evidence.pad,GST_PAD_PROBE_TYPE_BUFFER,CompressedEvidence::Observe,&evidence,nullptr);
 // Match the original worker's adaptive delay policy.
 auto controller=std::make_shared<ai_service::stream::AdaptiveDelayController>();
 auto buffer=std::make_shared<ai_service::stream::AuDelayBuffer>(controller,1.6,64*1024*1024,512);
 const std::string name="ainvr-source-sei-test-"+std::to_string(getpid());
 const std::string output="rtmp://127.0.0.1:1935/live/"+name;
 ai_service::stream::StreamPublisher::Config cfg;cfg.enabled=true;cfg.wait_for_initial_buffer=true;
 cfg.watchdog_timeout_seconds=8;
 ai_service::stream::StreamPublisher publisher([&source]{return source.GetEsSinkRef();},name,output,buffer,cfg,nullptr,
    [&source]{return std::optional<int64_t>(source.GetStreamGeneration());});
 publisher.SetCodecProvider([codec]{return codec;});publisher.Start();
 std::atomic<bool> stop{false};auto deadline=Clock::now()+std::chrono::seconds(50);
 const auto startup_deadline=Clock::now()+std::chrono::seconds(3);
 std::atomic<int64_t> first_steady_pts{-1};
 auto reader=std::async(std::launch::async,[&]{
  while((publisher.GetStats().au_pushed<1||first_steady_pts<0)&&!stop&&Clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(10));
  if(stop||Clock::now()>=deadline)throw std::runtime_error("No published packets reached SRS");
  MediaSource output_source(output,5000);auto oi=output_source.Info();
  if(oi.width!=info.width||oi.height!=info.height||oi.codec!=info.codec)throw std::runtime_error("Output stream format differs from source");
  VpuDecoder decoder(oi.codec,oi.width,oi.height);
  bool started=false;int verified=0,decoded=0;int64_t last_dts=-1;
  nlohmann::json samples=nlohmann::json::array();
  for(int read=0;read<180&&Clock::now()<deadline&&!stop;++read){
   auto packet=output_source.Read();if(!packet)break;
   std::optional<int64_t> stamp;
   for(auto& nal:Nals(packet->bytes)){
    if(ai_service::stream::NalType(codec,nal[0])!=(codec==ai_service::stream::VideoCodec::kH264?6:39))continue;
    for(auto& [type,payload]:ai_service::sei::parse_sei_nal(nal,codec)){
     const auto& uuid=ai_service::sei::SEI_UUID;
     if(type!=5||payload.size()<uuid.size()||!std::equal(uuid.begin(),uuid.end(),payload.begin()))continue;
     auto metadata=nlohmann::json::parse(payload.begin()+uuid.size(),payload.end());
     if(metadata.at("ch")!=name||!metadata.at("det").empty())throw std::runtime_error("Unexpected test transport metadata");
     stamp=metadata.at("pts").get<int64_t>();
     auto hash=VclHash(packet->bytes,codec);
     {std::lock_guard<std::mutex> lock(expected_mutex);auto match=expected.find(*stamp);
      if(match==expected.end()||match->second!=hash)throw std::runtime_error("Published VCL differs from original compressed frame");}
     if(!packet->dts_ns||*packet->dts_ns<last_dts)throw std::runtime_error("Published DTS is missing or moves backwards");
     last_dts=*packet->dts_ns;
     // SRS may send a cached GOP when the reader joins. Only frames stamped
     // after warmup count toward steady-state acceptance.
     if(*stamp>=first_steady_pts.load()){
      ++verified;
      if(samples.size()<3)samples.push_back({{"metadata",metadata},{"sei_nal_hex",Hex(nal)},{"vcl_sha256",hash}});
     }
    }
   }
   if(!started){if(!packet->key_frame)continue;started=true;}
   if(!decoder.Submit(packet->bytes,stamp.value_or(read),200))throw std::runtime_error("Output VPU input backpressure");
   if(auto frame=decoder.Receive(50)){if(frame->width!=info.width||frame->height!=info.height)throw std::runtime_error("Decoded output size differs");++decoded;}
   if(verified>=12&&decoded>=3)return nlohmann::json{{"verified_sei_frames",verified},{"vpu_decoded_frames",decoded},{"samples",samples}};
  }
  throw std::runtime_error("Insufficient SEI or VPU output evidence");
 });
 int sent=0,read=0,startup_misses=0,steady_stamps=0;
 try {
  while(steady_stamps<180&&read++<900&&Clock::now()<deadline){
   if(reader.wait_for(std::chrono::milliseconds(0))==std::future_status::ready)break;
   auto frame=source.PullFrameRef(100);
   if(!frame){auto stats=source.GetStats();if(stats.error)throw std::runtime_error(*stats.error);continue;}
   {std::lock_guard lock(expected_mutex);
    if(evidence.error)throw std::runtime_error(*evidence.error);
    // Frames already queued when the observation pad was installed are not test evidence.
    if(!expected.contains(frame->pts_ns))continue;
   }
   const bool steady=Clock::now()>=startup_deadline;
   if(steady&&first_steady_pts<0)first_steady_pts=frame->pts_ns;
   auto payload=ai_service::sei::build_result_payload(name,frame->pts_ns,0.0,{});
   auto nal=ai_service::sei::build_sei_nal(payload,codec);
   const auto limit=Clock::now()+std::chrono::milliseconds(100);
   ai_service::stream::StampResult status;
   do{
    status=buffer->stamp(frame->pts_ns,[nal,codec](const std::vector<uint8_t>& bytes){
       return ai_service::sei::inject_sei_annexb(bytes,nal,codec);},Mono(),source.GetStreamGeneration());
    if(status==ai_service::stream::StampResult::kStamped)break;
     // Late/dropped access units cannot reappear. Repeating their feedback
     // would inflate the original adaptive controller unlike the real worker.
     if(status!=ai_service::stream::StampResult::kUnknown)break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
   }while(Clock::now()<limit);
   if(status!=ai_service::stream::StampResult::kStamped){
    // Startup remains startup even if one early frame happened to succeed.
    // Every frame attempted after the bounded warmup is still strict.
    if(!steady&&startup_misses<90){
      ++startup_misses;continue;
    }
    const auto bs=buffer->stats();const auto ps=publisher.GetStats();
    throw std::runtime_error("Metadata was not attached to the matching buffered PTS: "+
      nlohmann::json{{"stamp_status",int(status)},{"frame_pts_ns",frame->pts_ns},
        {"source_generation",source.GetStreamGeneration()},{"au_in",ps.au_in},
        {"au_pushed",ps.au_pushed},{"buffer_put",bs.put},{"buffer_popped",bs.popped},
        {"buffer_level",bs.level},{"buffer_unknown",bs.unknown},{"buffer_too_late",bs.too_late},
        {"duplicate_pts",bs.duplicate_pts},{"generation_resets",bs.generation_reset_events}}.dump());
   }
   if(steady)++steady_stamps;
   ++sent;
  }
  if(reader.wait_for(std::chrono::seconds(7))!=std::future_status::ready)throw std::runtime_error("Output verification did not finish");
  auto output_evidence=reader.get();auto stats=publisher.GetStats();auto input_stats=source.GetStats();
  stop=true;publisher.Stop();source.Stop();
  nlohmann::json report={{"passed",true},{"purpose","isolated SEI transport validation; empty detections are test metadata, not model inference"},
   {"temporary_output_stream",name},{"source_size",{info.width,info.height}},{"display_frames_stamped",sent},
   {"startup_metadata_misses",startup_misses},{"startup_warmup_seconds",3},
   {"steady_frames_stamped",steady_stamps},{"first_steady_pts_ns",first_steady_pts.load()},
   {"steady_state_metadata_strict",true},{"final_adaptive_delay_seconds",buffer->stats().controller.delay_s},
   {"source_hardware_decoded_frames",input_stats.decoded},{"source_adapter","StreamSource/FrameRef S100P VPU"},
   {"publisher_au_in",stats.au_in},{"publisher_au_pushed",stats.au_pushed},{"sei_stamped",stats.sei_injected},
   {"publisher_reconnects",stats.reconnect_count},{"output_evidence",output_evidence},
   {"vcl_payloads_match_after_annexb_padding_normalization",true},{"video_reencoded",false},
   {"inference_executed",false},{"user_channel_configuration_modified",false}};
  std::ofstream file(argv[2]);file<<report.dump(2)<<"\n";file.close();if(!file)throw std::runtime_error("Report write failed");
  std::cout<<"Original publisher -> SRS -> SEI/VCL readback -> VPU validation passed\n";
 }catch(...){stop=true;publisher.Stop();source.Stop();throw;}
 return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}

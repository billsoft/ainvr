// Copyright AINVR. Isolated transport metadata, never publishes fake inference on user channels.
#include "stream/compressed_tap.hpp"
#include "stream/sei.hpp"
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
}
int main(int argc,char** argv){try{
 if(argc!=3)throw std::invalid_argument("Usage: probe input_url new_report.json");
 if(std::filesystem::exists(argv[2]))throw std::runtime_error("Report already exists");
 MediaSource source(argv[1],5000);auto info=source.Info();
 const auto codec=info.codec==Codec::H264?ai_service::stream::VideoCodec::kH264:ai_service::stream::VideoCodec::kH265;
 auto tap=std::make_shared<CompressedTap>(info.codec);
 auto controller=std::make_shared<ai_service::stream::AdaptiveDelayController>(.15,1.0);
 auto buffer=std::make_shared<ai_service::stream::AuDelayBuffer>(controller,1.6,64*1024*1024,512);
 const std::string name="ainvr-sei-transport-test-"+std::to_string(getpid());
 const std::string output="rtmp://127.0.0.1:1935/live/"+name;
 ai_service::stream::StreamPublisher::Config cfg;cfg.enabled=true;cfg.wait_for_initial_buffer=true;
 cfg.watchdog_timeout_seconds=8;
 ai_service::stream::StreamPublisher publisher([tap]{return tap->SinkReference();},name,output,buffer,cfg,nullptr,[]{return std::optional<int64_t>(1);});
 publisher.SetCodecProvider([codec]{return codec;});publisher.Start();
 std::mutex expected_mutex;std::map<int64_t,std::string> expected;
 std::atomic<bool> stop{false};auto deadline=Clock::now()+std::chrono::seconds(50);
 auto reader=std::async(std::launch::async,[&]{
  while(publisher.GetStats().au_pushed<1&&!stop&&Clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(10));
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
     last_dts=*packet->dts_ns;++verified;
     if(samples.size()<3)samples.push_back({{"metadata",metadata},{"sei_nal_hex",Hex(nal)},{"vcl_sha256",hash}});
    }
   }
   if(!started){if(!packet->key_frame)continue;started=true;}
   if(!decoder.Submit(packet->bytes,stamp.value_or(read),200))throw std::runtime_error("Output VPU input backpressure");
   if(auto frame=decoder.Receive(50)){if(frame->width!=info.width||frame->height!=info.height)throw std::runtime_error("Decoded output size differs");++decoded;}
   if(verified>=12&&decoded>=3)return nlohmann::json{{"verified_sei_frames",verified},{"vpu_decoded_frames",decoded},{"samples",samples}};
  }
  throw std::runtime_error("Insufficient SEI or VPU output evidence");
 });
 int sent=0,read=0;bool started=false;
 try {
  while(sent<180&&read++<900&&Clock::now()<deadline){
   if(reader.wait_for(std::chrono::milliseconds(0))==std::future_status::ready)break;
   auto packet=source.Read();if(!packet)break;
   if(!started){if(!packet->key_frame)continue;started=true;}
   auto limit=Clock::now()+std::chrono::seconds(2);std::optional<EncodedStamp> stamp;
   while(!(stamp=tap->Feed(*packet))){if(Clock::now()>limit)throw std::runtime_error("Compressed tap remained full");std::this_thread::sleep_for(std::chrono::milliseconds(2));}
   ++sent;
   {std::lock_guard<std::mutex> lock(expected_mutex);if(!expected.emplace(stamp->pts_ns,VclHash(packet->bytes,codec)).second)throw std::runtime_error("Duplicate source PTS cannot safely carry SEI");}
   while(buffer->stats().put<sent){if(Clock::now()>limit)throw std::runtime_error("Original publisher did not accept compressed packet");std::this_thread::sleep_for(std::chrono::milliseconds(1));}
   auto payload=ai_service::sei::build_result_payload(name,stamp->pts_ns,0.0,{});
   auto nal=ai_service::sei::build_sei_nal(payload,codec);
   auto status=buffer->stamp(stamp->pts_ns,[nal,codec](const std::vector<uint8_t>& bytes){return ai_service::sei::inject_sei_annexb(bytes,nal,codec);},Mono(),1);
   if(status!=ai_service::stream::StampResult::kStamped)throw std::runtime_error("Metadata was not attached to the matching buffered PTS");
   // A file is a transport fixture, not a live clock. Pace it so the original
   // arrival-time delay buffer can fill and an RTMP reader can join the stream.
   if(std::string(argv[1]).find("://")==std::string::npos)
    std::this_thread::sleep_for(std::chrono::nanoseconds(std::clamp<int64_t>(packet->duration_ns>0?packet->duration_ns:33333333,1000000,100000000)));
  }
  if(reader.wait_for(std::chrono::seconds(7))!=std::future_status::ready)throw std::runtime_error("Output verification did not finish");
  auto evidence=reader.get();auto stats=publisher.GetStats();stop=true;publisher.Stop();tap->Stop();source.Cancel();
  nlohmann::json report={{"passed",true},{"purpose","isolated SEI transport validation; empty detections are test metadata, not model inference"},
   {"temporary_output_stream",name},{"source_size",{info.width,info.height}},{"input_packets",sent},
   {"publisher_au_in",stats.au_in},{"publisher_au_pushed",stats.au_pushed},{"sei_stamped",stats.sei_injected},
   {"publisher_reconnects",stats.reconnect_count},{"output_evidence",evidence},
   {"vcl_payloads_match_after_annexb_padding_normalization",true},{"video_reencoded",false},
   {"inference_executed",false},{"user_channel_configuration_modified",false}};
  std::ofstream file(argv[2]);file<<report.dump(2)<<"\n";file.close();if(!file)throw std::runtime_error("Report write failed");
  std::cout<<"Original publisher -> SRS -> SEI/VCL readback -> VPU validation passed\n";
 }catch(...){stop=true;publisher.Stop();tap->Stop();throw;}
 return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}

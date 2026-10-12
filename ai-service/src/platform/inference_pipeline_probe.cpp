// Copyright AINVR. Bounded offline VPU -> PYM/GLES -> CPU ONNX -> detections.
#include "vpu_decoder.hpp"
#include "image_preprocessor.hpp"
#include "onnx_model.hpp"
#include "pipeline/frame_processor.hpp"
#include "stream/media_source.hpp"
#include "output/snapshot_renderer.hpp"
#include "output/archive_document.hpp"
#include "output/archive_spool.hpp"
#include <bson/bson.h>
#include <map>
#include <chrono>
#include <fstream>
#include <filesystem>
#include <iostream>
int main(int argc,char** argv){
  try{
    if(argc!=7&&argc!=9&&argc!=10)throw std::invalid_argument("Usage: ainvr_pipeline_probe model.onnx media scrfd|end2end max_frames output.json classes.json [new_snapshot_directory none|erp_equirect [new_spool_directory]]");
    int limit=std::stoi(argv[4]);if(limit<1||limit>1000)throw std::invalid_argument("Frame limit must be 1..1000");
    std::string task=argv[3];if(task!="scrfd"&&task!="end2end")throw std::invalid_argument("Unsupported decoder");
    if(std::filesystem::exists(argv[5]))throw std::invalid_argument("Output already exists");
    ai_service::config::SnapshotConfig snapshot_config;
    std::unique_ptr<ainvr::SnapshotRenderer> snapshots;
    std::unique_ptr<ainvr::ArchiveSpool> archive;
    std::filesystem::path snapshot_directory;
    if(argc>=9){
      snapshot_config.enabled=true;snapshot_config.projection_mode=argv[8];
      if(snapshot_config.projection_mode!="none"&&snapshot_config.projection_mode!="erp_equirect")
        throw std::invalid_argument("Invalid snapshot projection mode");
      snapshot_directory=argv[7];
      if(!std::filesystem::create_directory(snapshot_directory))throw std::invalid_argument("Snapshot directory must be new");
      snapshots=std::make_unique<ainvr::SnapshotRenderer>();
      if(argc==10){
        if(std::filesystem::exists(argv[9]))throw std::invalid_argument("Probe spool directory must be new");
        archive=std::make_unique<ainvr::ArchiveSpool>(argv[9],128*1024*1024,10000);
      }
    }
    std::ifstream class_file(argv[6]);nlohmann::json classes_json;class_file>>classes_json;auto classes=classes_json.get<std::vector<std::string>>();
    ainvr::FrameProcessorOptions processor_options;
    processor_options.model_path=argv[1];processor_options.classes=classes;
    processor_options.contract=task=="scrfd"?ainvr::DetectionContract::Scrfd:ainvr::DetectionContract::EndToEnd;
    ainvr::OnnxFrameProcessor processor(std::move(processor_options));
    ainvr::MediaSource source(argv[2]);const auto info=source.Info();auto codec=info.codec;
    ainvr::VpuDecoder decoder(codec,info.width,info.height);
    std::map<uint64_t,std::optional<int64_t>> timestamps;
    nlohmann::json frames=nlohmann::json::array();int packets=0;
    auto receive=[&](int timeout){
      auto wait_begin=std::chrono::steady_clock::now();
      auto frame=decoder.Receive(timeout);if(!frame)return false;
      const double received_at=std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
      auto begin=std::chrono::steady_clock::now();
      auto timestamp=timestamps.find(frame->pts);
      if(timestamp==timestamps.end())throw std::runtime_error("Unknown decoder frame token: "+std::to_string(frame->pts)+" after "+std::to_string(frames.size())+" frames");
      ainvr::FrameContext context;context.channel_id="offline-probe";context.index=frames.size();
      context.source_pts_ns=timestamp->second;context.received_at=received_at;
      context.decode_ms=std::chrono::duration<double,std::milli>(begin-wait_begin).count();
      context.bt709=info.bt709;context.full_range=info.full_range;
      auto processed=processor.Process(*frame,context);const auto& result=processed.result;
      auto row=result.ToDict();row["decode_backend"]="vpu-jpu";row["preprocess_backend"]=processed.preprocess_backend;row["fallback_reasons"]=processed.fallback_reasons;
      row["decode_packet_token"]=frame->pts;
      row["source_pts_ns"]=timestamp->second?nlohmann::json(*timestamp->second):nlohmann::json(nullptr);
      row["timestamp_semantics"]="source presentation time in nanoseconds; null when unavailable";
      row["wall_timestamp_semantics"]="Unix seconds when the decoded frame reached the offline pipeline; not camera capture time";
      if(snapshots){
        auto snapshot_begin=std::chrono::steady_clock::now();
        row["snapshots"]=nlohmann::json::array();
        for(size_t i=0;i<result.detections.size();++i){
          auto image=snapshots->RenderOriginal(*frame,result.detections[i].bbox,snapshot_config,task=="scrfd",info.bt709,info.full_range);
          if(!image)throw std::runtime_error("Accepted detection produced no snapshot");
          std::string archive_id;
          if(archive){
            bson_oid_t oid;bson_oid_init(&oid,nullptr);char hex[25];bson_oid_to_string(&oid,hex);archive_id=hex;
            ainvr::ArchiveDocumentInput record;record.image_id=archive_id;record.channel_name="AINVR offline probe";
            record.frame=result;record.detection_index=i;
            record.image={image->plan.width,image->plan.height,image->jpeg};record.original_image=record.image;
            archive->Stage(archive_id,ainvr::BuildArchiveDocument(record));
          }
          std::string name=std::to_string(result.frame_index)+"-"+std::to_string(i)+".jpg";
          auto destination=snapshot_directory/name;auto temporary=destination;temporary+=".tmp";
          std::ofstream file(temporary,std::ios::binary);file.write(reinterpret_cast<const char*>(image->jpeg.data()),image->jpeg.size());file.close();
          if(!file)throw std::runtime_error("Snapshot write failed");
          std::filesystem::rename(temporary,destination);
          row["snapshots"].push_back({{"detection_index",i},{"file",name},{"width",image->plan.width},{"height",image->plan.height},
            {"projection",snapshot_config.projection_mode},{"render_backend",image->render_backend},{"encoder_backend",image->encoder_backend},
            {"fallback_reasons",image->fallback_reasons}});
          if(archive)row["snapshots"].back()["archive_id"]=archive_id;
        }
        row["snapshot_ms"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-snapshot_begin).count();
      }
      timestamps.erase(timestamp);
      frames.push_back(std::move(row));return true;
    };
    while(frames.size()<size_t(limit)){
      auto packet=source.Read();if(!packet)break;
      if(timestamps.size()>=128)throw std::runtime_error("Too many undecoded packets");
      timestamps.emplace(packets,packet->pts_ns);
      auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
      while(!decoder.Submit(packet->bytes,packets,50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("VPU input stalled");}
      ++packets;receive(50);
    }
    if(frames.size()<size_t(limit)){
      auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
      if(codec!=ainvr::Codec::Jpeg)while(!decoder.Finish(50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("VPU end-of-stream stalled");}
      while(frames.size()<size_t(limit)&&std::chrono::steady_clock::now()<deadline)receive(100);
    }
    if(frames.size()!=size_t(limit))throw std::runtime_error("Did not process requested frame count");
    std::ofstream output(argv[5]);if(!output)throw std::runtime_error("Cannot write report");output<<nlohmann::json({{"frames",frames},{"model_provider","cpu"},{"scope","offline pipeline; not deployed channel service"}}).dump(2)<<"\n";
    output.close();if(!output)throw std::runtime_error("Report write failed");std::cout<<"Processed "<<frames.size()<<" frames\n";return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}

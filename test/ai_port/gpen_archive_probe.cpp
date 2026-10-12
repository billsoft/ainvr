// Copyright AINVR. Real GPEN BPU -> production snapshot queue -> JPU -> test Mongo.
// Detections and input fixture are injected; this does not test face detection.
#include "output/snapshot_store.hpp"
#include "output/face_enhancer_bpu.hpp"
#include "output/snapshot_jpeg.hpp"
#include "platform/face_restore_gles.hpp"
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <unistd.h>
namespace fs=std::filesystem;
using nlohmann::json;
void Require(bool value,const char* error){if(!value)throw std::runtime_error(error);}
int main(int argc,char** argv){try{
  Require(argc==5,"Usage: model.hbm input-96x96.rgba workspace report.json");
  const char* uri=std::getenv("AI_SERVICE_TEST_MONGO_URI");Require(uri&&*uri,"Missing private test Mongo URI");
  const fs::path root=fs::canonical(argv[3]);
  Require(root.string().rfind("/mnt/ainvr-ssd/test-scratch/gpen-archive-",0)==0,"Use isolated SSD scratch");
  const std::string id="gpen-test-"+std::to_string(getpid());
  const std::string database="ainvr_gpen_snapshot_tests";
  fs::create_directory(root/id);
  cv::Mat input(96,96,CV_8UC4);std::ifstream file(argv[2],std::ios::binary);
  file.read(reinterpret_cast<char*>(input.data),96*96*4);Require(file.gcount()==96*96*4,"Invalid RGBA fixture");
  ai_service::output::RegisterFaceEnhancerBpu("/home/sunrise/ainvr/ai-service");
  ai_service::config::SnapshotConfig cfg;cfg.enabled=true;cfg.min_interval_ms=0;
  cfg.max_count=100;cfg.max_crop_dimension=128;cfg.padding_ratio=0;cfg.jpeg_quality=95;
  cfg.face_enhance_model="gpen";cfg.face_enhance_blend=.5;cfg.brightness_enabled=false;
  ai_service::output::SnapshotStore store(cfg,uri,database,id,"GPEN integration fixture",
    argv[1],"",64,true,(root/id).string());
  store.Start();
  ai_service::Detection det;det.class_id=0;det.class_name="face";det.confidence=.9;det.bbox={0,0,96,96};
  ai_service::pipeline::SnapshotSink::FrameProvider provider{input.size(),[&](const cv::Rect& roi,cv::Mat& out){input(roi).copyTo(out);}};
  constexpr int warmup=12,timed_frames=24,frames=warmup+timed_frames;
  auto offer=[&](int begin,int end){for(int i=begin;i<end;++i)store.Offer(provider,id,"GPEN integration fixture",int64_t(i)*100000000,
    1791792000+i*.1,"injected-face-detection","face_detection",{det},{det},false,cfg);};
  json stats;
  auto wait=[&](int count){auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(60);
    do{stats=store.GetStats();if(stats["delivery"]["committed"]==count)return;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }while(std::chrono::steady_clock::now()<deadline);
    throw std::runtime_error("Archive warm/timed phase did not finish");};
  offer(0,warmup);wait(warmup);
  const auto warm_stats=stats;
  auto start=std::chrono::steady_clock::now();offer(warmup,frames);wait(frames);
  const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  Require(stats["delivery"]["committed"]==frames,"Archive did not commit all frames");
  Require(stats["delivery"]["quarantined"]==0,"Archive quarantined a frame");
  Require(stats["enhanced_count"]==frames,"GPEN was not executed for every frame");
  auto page=store.ListPage({},100,0,{},{});Require(page["items"].size()==frames,"Mongo record count mismatch");
  int verified=0;
  for(const auto& item:page["items"]){
    const auto image_id=item["image_id"].get<std::string>();
    auto image=store.GetImage(image_id),original=store.GetImage(image_id,true);
    Require(image&&original&&image->size()>4&&original->size()>4,"Missing archived image variants");
    Require((*image)[0]==255&&(*image)[1]==216&&(*original)[0]==255&&(*original)[1]==216,"Invalid archived JPEG");
    Require(*image!=*original,"Enhanced and original JPEG unexpectedly identical");
    if(!verified){std::ofstream(root/"enhanced.jpg",std::ios::binary).write(reinterpret_cast<const char*>(image->data()),image->size());
      std::ofstream(root/"original.jpg",std::ios::binary).write(reinterpret_cast<const char*>(original->data()),original->size());}
    ++verified;
  }
  store.Stop();
  Require(ainvr::GetFaceRestoreStats().cpu_runs==0,"CPU restoration path used");
  Require(ai_service::output::GetSnapshotJpegStats().cpu==0,"CPU JPEG encoder used");
  const auto jpeg_stats=ai_service::output::GetSnapshotJpegStats();
  Require(jpeg_stats.encoder_creates==2&&jpeg_stats.encoder_reuses>=frames*2-2,"Original/enhanced encoder cache did not reuse its two contexts");
  json report={{"passed",true},{"records",verified},{"warmup_records",warmup},{"timed_records",timed_frames},
    {"seconds",seconds},{"archive_fps",timed_frames/seconds},{"warmup_stats",warm_stats},
    {"stats",stats},{"jpeg_encoder_creates",jpeg_stats.encoder_creates},{"jpeg_encoder_reuses",jpeg_stats.encoder_reuses},
    {"database",database},{"channel_id",id},{"input_fixture",true},{"detection_fixture",true},
    {"real_gpen_hbm_inference",true},{"original_and_enhanced_archived",true},{"production_channel_changed",false}};
  std::ofstream(argv[4])<<report.dump(2);std::cout<<report.dump()<<'\n';
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}

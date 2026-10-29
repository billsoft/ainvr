// Copyright AINVR.
#include "output/snapshot_renderer.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <chrono>
#if defined(AINVR_JPEG_DECODE_LAYOUT_DIAGNOSTIC)
#include "platform/vpu_decoder.hpp"
#include "../../llm-service/src/request.hpp"
#include <hb_media_codec.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
namespace {
struct JpegLayout {
  bool enabled=false,available=false;
  int rc=0,width=0,height=0,stride=0,vstride=0,pixel_format=0;
  unsigned size=0,components[3]{};
  int display_width=0,display_height=0,decode_result=0,display_index=0,error_x=0,error_y=0;
  bool crop_enabled=false;
  unsigned crop[4]{};
} jpeg_layout;
}
// Diagnostic binary only. GNU --wrap redirects this probe's existing
// VpuDecoder call; the driver receives exactly the original arguments. No
// pixel/pointer/address data is logged and the production decoder is unchanged.
extern "C" hb_s32 __real_hb_mm_mc_dequeue_output_buffer(media_codec_context_t*,media_codec_buffer_t*,media_codec_output_buffer_info_t*,hb_s32);
extern "C" hb_s32 __wrap_hb_mm_mc_dequeue_output_buffer(media_codec_context_t* context,media_codec_buffer_t* buffer,media_codec_output_buffer_info_t* info,hb_s32 timeout){
  const auto rc=__real_hb_mm_mc_dequeue_output_buffer(context,buffer,info,timeout);
  if(jpeg_layout.enabled){
    jpeg_layout.rc=rc;
    if(rc==0&&context&&buffer&&info&&context->codec_id==MEDIA_CODEC_ID_JPEG&&!context->encoder){
      const auto& v=buffer->vframe_buf;const auto& j=info->jpeg_frame_info;const auto& crop=context->video_dec_params.jpeg_dec_config.crop_rect;
      jpeg_layout.width=v.width;jpeg_layout.height=v.height;jpeg_layout.stride=v.stride;jpeg_layout.vstride=v.vstride;
      jpeg_layout.pixel_format=v.pix_fmt;jpeg_layout.size=v.size;
      for(int i=0;i<3;++i)jpeg_layout.components[i]=v.compSize[i];
      jpeg_layout.display_width=j.display_width;jpeg_layout.display_height=j.display_height;jpeg_layout.decode_result=j.decode_result;
      jpeg_layout.display_index=j.frame_display_index;jpeg_layout.error_x=j.err_pos_x;jpeg_layout.error_y=j.err_pos_y;
      jpeg_layout.crop_enabled=context->video_dec_params.jpeg_dec_config.frame_crop_enable;
      jpeg_layout.crop[0]=crop.x_pos;jpeg_layout.crop[1]=crop.y_pos;jpeg_layout.crop[2]=crop.width;jpeg_layout.crop[3]=crop.height;
      jpeg_layout.available=true;
    }
  }
  return rc;
}
int JpegDecode(const std::filesystem::path& path){
  namespace fs=std::filesystem;
  const auto allowed=fs::canonical("test/results"),parent=fs::canonical(path.parent_path());
  const auto relative=parent.lexically_relative(allowed);
  if(relative.empty()||relative.is_absolute()||*relative.begin()=="..")throw std::runtime_error("JPEG diagnostic requires test/results input");
  const int fd=open(path.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  if(fd<0)throw std::runtime_error("JPEG diagnostic input unavailable");
  struct Close{int fd;~Close(){close(fd);}} close_input{fd};struct stat before{},after{};
  if(fstat(fd,&before)||!S_ISREG(before.st_mode)||before.st_size<4||before.st_size>8*1024*1024)
    throw std::runtime_error("JPEG diagnostic input type/size invalid");
  std::vector<uint8_t> bytes(size_t(before.st_size));size_t at=0;
  while(at<bytes.size()){const auto count=read(fd,bytes.data()+at,bytes.size()-at);if(count<=0)throw std::runtime_error("JPEG diagnostic input read failed");at+=size_t(count);}
  if(fstat(fd,&after)||before.st_dev!=after.st_dev||before.st_ino!=after.st_ino||before.st_size!=after.st_size||
      before.st_mtim.tv_sec!=after.st_mtim.tv_sec||before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec||
      before.st_ctim.tv_sec!=after.st_ctim.tv_sec||before.st_ctim.tv_nsec!=after.st_ctim.tv_nsec)
    throw std::runtime_error("JPEG diagnostic input changed");
  const auto dimensions=ainvr::llm::JpegDimensions(bytes,true);
  nlohmann::json result{{"diagnostic_only",true},{"bpu_executed",false},{"cpu_decode_fallback",false},
    {"visible_coordinates_interpreted",false},{"request_width",dimensions[0]},{"request_height",dimensions[1]},
    {"input_bytes",bytes.size()},{"decode_succeeded",false}};
  std::string stage="initialize";const auto began=std::chrono::steady_clock::now();
  try{
    jpeg_layout=JpegLayout{};jpeg_layout.enabled=true;
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,dimensions[0],dimensions[1]);stage="submit";
    if(!decoder.Submit(bytes,1,1000))throw std::runtime_error("diagnostic_submit_timeout");
    stage="receive";const auto image=decoder.Receive(3000);
    if(!image)throw std::runtime_error("diagnostic_receive_timeout");
    result["decode_succeeded"]=true;result["returned_packed_layout"]={{"width",image->width},{"height",image->height},{"bytes",image->pixels.size()}};
    unsigned char digest[EVP_MAX_MD_SIZE];unsigned digest_size=0;
    if(!EVP_Digest(image->pixels.data(),image->pixels.size(),digest,&digest_size,EVP_sha256(),nullptr)||digest_size!=32)
      throw std::runtime_error("diagnostic_hash_failed");
    constexpr char digits[]="0123456789abcdef";std::string hex;hex.reserve(64);
    for(unsigned i=0;i<digest_size;++i){hex.push_back(digits[digest[i]>>4]);hex.push_back(digits[digest[i]&15]);}
    result["returned_nv12_sha256"]=hex;
  }catch(const std::exception& error){
    const std::string text=error.what();
    result["error_code"]=text=="Unsupported decoded frame layout/resolution change"?"unsupported_decoded_layout":
      text=="JPEG decoder reported damaged or unsupported image"?"jpeg_decoder_rejected_image":
      text=="Invalid access unit size"?"compressed_input_exceeds_decoder_buffer":
      text=="diagnostic_submit_timeout"?"submit_timeout":text=="diagnostic_receive_timeout"?"receive_timeout":"hardware_decode_failed";
  }
  jpeg_layout.enabled=false;
  result["stage"]=stage;result["dequeue_rc"]=jpeg_layout.rc;result["driver_metadata_available"]=jpeg_layout.available;
  if(jpeg_layout.available)result["driver_layout"]={{"width",jpeg_layout.width},{"height",jpeg_layout.height},{"stride",jpeg_layout.stride},
    {"vstride",jpeg_layout.vstride},{"pixel_format",jpeg_layout.pixel_format},{"buffer_bytes",jpeg_layout.size},
    {"component_bytes",{jpeg_layout.components[0],jpeg_layout.components[1],jpeg_layout.components[2]}},
    {"display_width",jpeg_layout.display_width},{"display_height",jpeg_layout.display_height},{"decode_result",jpeg_layout.decode_result},
    {"display_index",jpeg_layout.display_index},{"error_mcu_x",jpeg_layout.error_x},{"error_mcu_y",jpeg_layout.error_y},
    {"configured_crop_enabled",jpeg_layout.crop_enabled},{"configured_crop",{jpeg_layout.crop[0],jpeg_layout.crop[1],jpeg_layout.crop[2],jpeg_layout.crop[3]}}};
  result["elapsed_ms"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-began).count();
  std::cout<<result.dump()<<'\n';return jpeg_layout.available?0:1;
}
#endif
int ErpHardware(const std::filesystem::path& out){
  namespace fs=std::filesystem;
  const auto allowed=fs::canonical("test/results"),parent=fs::canonical(out.parent_path());
  const auto relative=parent.lexically_relative(allowed);
  if(relative.empty()||relative.is_absolute()||*relative.begin()==".."||!fs::create_directory(out))
    throw std::runtime_error("Expected fresh output directory under test/results");
  ainvr::Nv12Frame frame;frame.width=640;frame.height=320;frame.pixels.resize(size_t(640)*320*3/2);
  for(int y=0;y<320;++y)for(int x=0;x<640;++x)frame.pixels[size_t(y)*640+x]=32+(x*160/640+y*32/320)%190;
  for(size_t i=size_t(640)*320;i<frame.pixels.size();i+=2){frame.pixels[i]=100;frame.pixels[i+1]=155;}
  ainvr::SnapshotRenderer renderer({},ainvr::SnapshotEncodingPolicy::HardwareOnly);
  ai_service::config::SnapshotConfig cfg;cfg.enabled=true;cfg.projection_mode="erp_equirect";
  cfg.padding_ratio=0;cfg.max_crop_dimension=320;cfg.jpeg_quality=90;
  const std::array<double,4> box{240,120,80,80};
  const auto plan=ainvr::PlanSnapshot(box,640,320,cfg,false);
  if(!plan||!plan->perspective||plan->source_rectangle!=std::array<double,4>{})throw std::runtime_error("ERP plan contract changed");
  nlohmann::json cases=nlohmann::json::array();
  for(int i=0;i<2;++i){
    const auto start=std::chrono::steady_clock::now();
    auto image=i==0?renderer.RenderOriginal(frame,box,cfg,false,false,true):
      std::optional<ainvr::EncodedSnapshot>(renderer.RenderPlanned(frame,*plan,cfg.jpeg_quality,false,true));
    if(!image||image->render_backend!="gles"||image->encoder_backend!="jpu"||!image->fallback_reasons.empty())
      throw std::runtime_error("ERP hardware backend contract failed");
    const auto name=i==0?"erp-original.jpg":"erp-explicit.jpg";
    std::ofstream file(out/name,std::ios::binary);file.write(reinterpret_cast<const char*>(image->jpeg.data()),image->jpeg.size());file.close();
    if(!file)throw std::runtime_error("ERP output write failed");
    cases.push_back({{"file",name},{"interface",i==0?"RenderOriginal":"RenderPlanned"},{"width",image->plan.width},
      {"height",image->plan.height},{"yaw",image->plan.yaw},{"pitch",image->plan.pitch},{"horizontal_fov",image->plan.horizontal_fov},
      {"source_rectangle",image->plan.source_rectangle},{"render_backend",image->render_backend},{"encoder_backend",image->encoder_backend},
      {"elapsed_ms",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()}});
  }
  const nlohmann::json report{{"passed",true},{"bpu_executed",false},{"cpu_image_processing",false},{"semantic_accuracy_verified",false},
    {"source_width",640},{"source_height",320},{"bbox",box},{"projection_mode","erp_equirect"},{"cases",cases}};
  std::ofstream summary(out/"summary.json");summary<<report.dump(2)<<'\n';summary.close();if(!summary)throw std::runtime_error("ERP report write failed");
  std::cout<<report.dump()<<'\n';return 0;
}
int main(int argc,char**argv){try{
  if(argc==2&&std::string(argv[1])=="--help"){
    std::cout<<"Manual hardware only: --run-erp-hardware test/results/NEW-DIRECTORY (GLES/JPU, no BPU or CPU image fallback)\n";
#if defined(AINVR_JPEG_DECODE_LAYOUT_DIAGNOSTIC)
    std::cout<<"Manual JPEG diagnostic: --run-jpeg-decode test/results/IMAGE.jpg (existing VpuDecoder/JPU; link --wrap=hb_mm_mc_dequeue_output_buffer; no BPU/CPU decode)\n";
#endif
    return 0;}
#if defined(AINVR_JPEG_DECODE_LAYOUT_DIAGNOSTIC)
  if(argc==3&&std::string(argv[1])=="--run-jpeg-decode")return JpegDecode(argv[2]);
#endif
  if(argc==3&&std::string(argv[1])=="--run-erp-hardware")return ErpHardware(argv[2]);
  if(argc!=2||!std::filesystem::create_directory(argv[1]))throw std::runtime_error("Expected new output directory");
  std::filesystem::path out(argv[1]);
  ainvr::Nv12Frame frame;frame.width=640;frame.height=320;frame.pixels.resize(640*320*3/2,128);
  std::fill_n(frame.pixels.begin(),640*320,100);
  ainvr::SnapshotRenderer renderer;
  ai_service::config::SnapshotConfig cfg;cfg.padding_ratio=0;cfg.max_crop_dimension=320;cfg.jpeg_quality=90;
  if(renderer.RenderOriginal(frame,{100,100,80,80},cfg,false,false,true))throw std::runtime_error("Disabled snapshot emitted");
  cfg.enabled=true;
  if(renderer.RenderOriginal(frame,{0,0,0,10},cfg,false,false,true))throw std::runtime_error("Invalid detection emitted");
  nlohmann::json cases=nlohmann::json::array();
  for(int i=0;i<6;++i){
    cfg.projection_mode=i==4?"erp_equirect":"none";
    std::array<double,4> box=i==0?std::array<double,4>{100,100,80,80}:i==1?std::array<double,4>{10,10,21,19}:i==2?std::array<double,4>{10,10,1,1}:i==3?std::array<double,4>{10,10,2,2}:std::array<double,4>{240,120,80,80};
    auto image=renderer.RenderOriginal(frame,box,cfg,false,false,true);if(!image)throw std::runtime_error("Missing snapshot");
    if(i==0&&image->encoder_backend!="jpu")throw std::runtime_error("JPU was not used");
    if(i>=1&&i<=3&&image->encoder_backend!="cpu-libjpeg")throw std::runtime_error("Missing CPU encoder fallback");
    std::ofstream file(out/(std::to_string(i)+".jpg"),std::ios::binary);file.write(reinterpret_cast<const char*>(image->jpeg.data()),image->jpeg.size());if(!file)throw std::runtime_error("JPEG write failed");
    cases.push_back({{"name",std::to_string(i)},{"width",image->plan.width},{"height",image->plan.height},{"render",image->render_backend},{"encoder",image->encoder_backend},{"erp",image->plan.perspective}});
  }
  cfg.jpeg_quality=101;bool rejected=false;
  try{renderer.RenderOriginal(frame,{10,10,80,80},cfg,false,false,true);}catch(const std::invalid_argument&){rejected=true;}
  if(!rejected)throw std::runtime_error("Invalid quality accepted");
  std::ofstream report(out/"summary.json");report<<cases.dump(2);if(!report)throw std::runtime_error("Report failed");
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}

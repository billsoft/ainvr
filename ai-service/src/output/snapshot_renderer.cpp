// Copyright AINVR.
#include "snapshot_renderer.hpp"
#include <algorithm>
#include <cmath>
#include <csetjmp>
#include <cstdio>
#include <cstdlib>
#include <jpeglib.h>
#include <stdexcept>
namespace ainvr {
namespace {
struct CpuJpeg {
  jpeg_compress_struct codec{};
  jpeg_error_mgr error{};
  std::jmp_buf jump;
  char message[JMSG_LENGTH_MAX]{};
  unsigned char* bytes=nullptr;
  unsigned long size=0;
  bool created=false;
  ~CpuJpeg(){if(created)jpeg_destroy_compress(&codec);std::free(bytes);}
};
void JpegFailure(j_common_ptr codec){
  auto* state=static_cast<CpuJpeg*>(codec->client_data);
  (*codec->err->format_message)(codec,state->message);
  std::longjmp(state->jump,1);
}
std::vector<uint8_t> EncodeCpu(const std::vector<float>& chw,int w,int h,int quality){
  const size_t area=size_t(w)*h;
  if(chw.size()!=area*3||!std::all_of(chw.begin(),chw.end(),[](float x){return std::isfinite(x);}))
    throw std::invalid_argument("Invalid snapshot RGB pixels");
  // Objects survive outside the setjmp region; the C error callback never
  // jumps across construction/destruction of C++ objects.
  auto state=std::make_unique<CpuJpeg>();std::vector<uint8_t> row(size_t(w)*3);
  auto* s=state.get();s->codec.err=jpeg_std_error(&s->error);s->error.error_exit=JpegFailure;
  s->codec.client_data=s;
  if(setjmp(s->jump))throw std::runtime_error(std::string("CPU JPEG: ")+s->message);
  s->created=true;jpeg_create_compress(&s->codec);
  jpeg_mem_dest(&s->codec,&s->bytes,&s->size);
  s->codec.image_width=w;s->codec.image_height=h;s->codec.input_components=3;s->codec.in_color_space=JCS_RGB;
  jpeg_set_defaults(&s->codec);jpeg_set_quality(&s->codec,quality,TRUE);jpeg_start_compress(&s->codec,TRUE);
  while(s->codec.next_scanline<s->codec.image_height){
    size_t offset=size_t(s->codec.next_scanline)*w;
    for(int x=0;x<w;++x)for(int c=0;c<3;++c)
      row[size_t(x)*3+c]=uint8_t(std::floor(std::clamp(chw[size_t(c)*area+offset+x],0.f,255.f)+.5f));
    JSAMPROW scanline=row.data();jpeg_write_scanlines(&s->codec,&scanline,1);
  }
  jpeg_finish_compress(&s->codec);
  return {s->bytes,s->bytes+s->size};
}
}  // namespace
std::optional<EncodedSnapshot> SnapshotRenderer::RenderOriginal(const Nv12Frame& frame,
    const std::array<double,4>& bbox,const ai_service::config::SnapshotConfig& cfg,
    bool square,bool bt709,bool full_range){
  if(!cfg.enabled)return std::nullopt;
  if(cfg.jpeg_quality<1||cfg.jpeg_quality>100)throw std::invalid_argument("Invalid snapshot JPEG quality");
  auto plan=PlanSnapshot(bbox,frame.width,frame.height,cfg,square);if(!plan)return std::nullopt;
  auto t=SnapshotTransform(*plan,bt709,full_range);EncodedSnapshot result;result.plan=*plan;
  const bool aligned=t.width>=18&&t.height>=18&&t.width%2==0&&t.height%2==0;
  if(policy_==SnapshotEncodingPolicy::HardwareOnly && !aligned)
    throw std::runtime_error("snapshot_hardware_dimensions_unsupported");
  if(hardware_&&aligned){
    auto image=images_.RunJpegNv12(frame,t);result.render_backend=image.backend;result.fallback_reasons=image.fallback_reasons;
    try{
      std::array<int,3> key{t.width,t.height,cfg.jpeg_quality};
      if(!jpeg_||jpeg_config_!=key){jpeg_.reset();jpeg_=std::make_unique<JpegEncoder>(key[0],key[1],key[2]);jpeg_config_=key;}
      result.jpeg=jpeg_->EncodeFullRangeNv12(image.jpeg_nv12);result.encoder_backend="jpu";return result;
    }catch(const std::runtime_error& e){jpeg_.reset();
      if(policy_==SnapshotEncodingPolicy::HardwareOnly)throw std::runtime_error("snapshot_hardware_encode_failed");
      result.fallback_reasons.push_back(std::string("JPU failed: ")+e.what());}
  }else result.fallback_reasons.push_back(hardware_?"JPU requires even dimensions at least 18; preserve crop with CPU JPEG":"Dedicated hardware disabled");
  auto image=images_.RunNv12(frame,t);result.render_backend=image.backend;
  result.fallback_reasons.insert(result.fallback_reasons.end(),image.fallback_reasons.begin(),image.fallback_reasons.end());
  result.jpeg=EncodeCpu(image.chw,t.width,t.height,cfg.jpeg_quality);result.encoder_backend="cpu-libjpeg";return result;
}
}  // namespace ainvr

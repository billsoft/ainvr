// Copyright AINVR. ERP to perspective using the dedicated GDC custom mesh.
#include "gdc_projector.hpp"
#include "media_memory.hpp"
#include <hbn_vpf_data_info.h>
#include <hbn_vpf_interface.h>
#include <chrono>
#include <cmath>
#include <cstring>
#include <mutex>
#include <numbers>
#include <stdexcept>
#include <string>
namespace ainvr {
namespace {
constexpr double Pi=std::numbers::pi;
void Check(int rc,const char* op){if(rc)throw std::runtime_error(std::string(op)+": "+std::to_string(rc));}
}
struct GdcProjector::State {
  int w=0,h=0,ow=0,oh=0;double configuration_ms=0;
  hbn_vnode_handle_t node{};hbn_vflow_handle_t flow{};
  hbn_vnode_image_t input{};hb_mem_common_buf_t binary{};
  bool allocated=false,bin_allocated=false,opened=false,created=false,started=false,failed=false;
  std::mutex mutex;
  ~State(){
    if(started)hbn_vflow_stop(flow);
    if(opened)hbn_vnode_close(node);
    if(created)hbn_vflow_destroy(flow);
    if(allocated)hb_mem_free_buf(input.buffer.fd[0]);
    if(bin_allocated)hb_mem_free_buf(binary.fd);
  }
};
bool GdcProjector::Supports(int w,int h,const ImageTransform& t){
  if(!t.erp_perspective||t.nearest||w<96||h<96||w>3840||h>2160||w%16||h%2||
     t.width<96||t.height<96||t.width>3840||t.height>2160||t.width%16||t.height%2||
     !std::isfinite(t.yaw)||!std::isfinite(t.pitch)||!(t.horizontal_fov>0&&t.horizontal_fov<Pi))return false;
  // Bound the entire view by a cone to exclude poles and longitude wrapping.
  double tangent=std::tan(t.horizontal_fov/2.);
  double cone=std::atan(std::hypot(tangent,tangent*t.height/t.width));
  if(std::abs(t.pitch)+cone>=Pi/2-0.03)return false;
  double longitude=std::asin(std::sin(cone)/std::cos(t.pitch));
  return std::abs(std::remainder(double(t.yaw),2*Pi))+longitude<Pi-0.03;
}
GdcProjector::GdcProjector(int w,int h,const ImageTransform& t):state_(std::make_unique<State>()){
  if(!Supports(w,h,t))throw std::invalid_argument("GDC perspective outside validated dimensions or continuous ERP region");
  auto begin=std::chrono::steady_clock::now();EnsureMediaMemory();auto& s=*state_;
  s.w=w;s.h=h;s.ow=t.width;s.oh=t.height;
  std::vector<point_t> points(size_t(s.ow+1)*(s.oh+1));
  double tangent=std::tan(t.horizontal_fov/2.),cp=std::cos(t.pitch),sp=std::sin(t.pitch),cy=std::cos(t.yaw),sy=std::sin(t.yaw);
  for(int y=0;y<=s.oh;++y)for(int x=0;x<=s.ow;++x){
    double dx=((x+.5)/s.ow*2-1)*tangent,dy=-((y+.5)/s.oh*2-1)*tangent*s.oh/s.ow,dz=1;
    double len=std::sqrt(dx*dx+dy*dy+dz*dz);dx/=len;dy/=len;dz/=len;
    double py=cp*dy+sp*dz,pz=-sp*dy+cp*dz;
    double rx=cy*dx+sy*pz,rz=-sy*dx+cy*pz;
    auto& point=points[size_t(y)*(s.ow+1)+x];
    point.x=(std::atan2(rx,rz)/(2*Pi)+.5)*w-.5;
    point.y=(.5-std::asin(py)/Pi)*h-.5;
  }
  param_t param{};param.format=FMT_SEMIPLANAR_420;param.in={uint32_t(w),uint32_t(h)};param.out={uint32_t(s.ow),uint32_t(s.oh)};param.fov=180;param.diameter=h;
  window_t window{};window.transform=CUSTOM;window.zoom=1;window.out_r={0,0,s.ow,s.oh};window.input_roi_r={0,0,w,h};
  window.custom.full_tile_calc=1;window.custom.tile_incr_x=8;window.custom.tile_incr_y=8;
  window.custom.w=s.ow;window.custom.h=s.oh;window.custom.centerx=s.ow/2.;window.custom.centery=s.oh/2.;window.custom.points=points.data();
  void* generated=nullptr;uint64_t size=0;
  struct FreeConfig {void*& data;~FreeConfig(){if(data)hbn_free_gdc_cfg(static_cast<uint32_t*>(data));}} free_config{generated};
  Check(hbn_gen_gdc_cfg(&param,&window,1,&generated,&size),"generate GDC mesh");
  if(!generated||!size||size>UINT32_MAX)throw std::runtime_error("Invalid GDC configuration size");
  int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED|HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF;
  Check(hb_mem_alloc_com_buf(size,flags,&s.binary),"allocate GDC configuration");s.bin_allocated=true;
  std::memcpy(s.binary.virt_addr,generated,size);Check(hb_mem_flush_buf(s.binary.fd,0,size),"flush GDC configuration");
  Check(hb_mem_alloc_graph_buf(w,h,MEM_PIX_FMT_NV12,flags,w,h,&s.input.buffer),"allocate GDC input");s.allocated=true;
  gdc_settings_t settings{};auto& config=settings.gdc_config;
  config.config_addr=s.binary.phys_addr;config.config_size=size;
  config.input_width=w;config.input_height=h;config.input_stride=s.input.buffer.stride;
  config.output_width=s.ow;config.output_height=s.oh;config.output_stride=s.ow;config.total_planes=2;
  settings.binary_ion_id=s.binary.share_id;settings.binary_offset=s.binary.offset;settings.magicNumber=0x12345678;
  Check(hbn_vnode_open(HB_GDC,0,-1,&s.node),"open GDC");s.opened=true;
  Check(hbn_vnode_set_attr(s.node,&settings),"configure GDC");
  Check(hbn_vnode_set_ichn_attr(s.node,0,&settings),"configure GDC input");
  Check(hbn_vnode_set_ochn_attr(s.node,0,&settings),"configure GDC output");
  hbn_buf_alloc_attr_t alloc{};alloc.buffers_num=3;alloc.is_contig=1;alloc.flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED;
  Check(hbn_vnode_set_ochn_buf_attr(s.node,0,&alloc),"allocate GDC output");
  Check(hbn_vflow_create(&s.flow),"create GDC flow");s.created=true;
  Check(hbn_vflow_add_vnode(s.flow,s.node),"add GDC flow node");
  Check(hbn_vflow_start(s.flow),"start GDC flow");s.started=true;
  s.configuration_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count();
}
GdcProjector::~GdcProjector()=default;
double GdcProjector::ConfigurationMilliseconds()const{return state_->configuration_ms;}
Nv12Frame GdcProjector::Run(const Nv12Frame& src){
  auto& s=*state_;std::lock_guard lock(s.mutex);
  if(src.width!=s.w||src.height!=s.h||src.pixels.size()!=size_t(s.w)*s.h*3/2)throw std::invalid_argument("Invalid GDC packed NV12 input");
  if(s.failed)throw std::runtime_error("GDC instance failed; recreate before reuse");
  s.failed=true;auto& b=s.input.buffer;
  for(int plane=0;plane<2;++plane){
    int rows=plane?s.h/2:s.h;size_t offset=plane?size_t(s.w)*s.h:0;
    for(int y=0;y<rows;++y)std::memcpy(b.virt_addr[plane]+size_t(y)*b.stride,src.pixels.data()+offset+size_t(y)*s.w,s.w);
  }
  Check(hb_mem_flush_buf(b.fd[0],0,b.size[0]+b.size[1]),"flush GDC input");
  gettimeofday(&s.input.info.tv,nullptr);Check(hbn_vnode_sendframe(s.node,0,&s.input),"submit GDC input");
  hbn_vnode_image_t out{};Check(hbn_vnode_getframe(s.node,0,2000,&out),"receive GDC output");
  struct Release {State& s;hbn_vnode_image_t& out;bool active=true;~Release(){if(active)hbn_vnode_releaseframe(s.node,0,&out);}} release{s,out};
  auto& dst=out.buffer;
  if(dst.width!=s.ow||dst.height!=s.oh||dst.stride<s.ow||!dst.virt_addr[0]||!dst.virt_addr[1])throw std::runtime_error("Invalid GDC output layout");
  Check(hb_mem_invalidate_buf(dst.fd[0],0,dst.size[0]+dst.size[1]),"invalidate GDC output");
  Nv12Frame result{s.ow,s.oh,src.pts,{}};result.pixels.resize(size_t(s.ow)*s.oh*3/2);
  for(int plane=0;plane<2;++plane){
    int rows=plane?s.oh/2:s.oh;size_t offset=plane?size_t(s.ow)*s.oh:0;
    for(int y=0;y<rows;++y)std::memcpy(result.pixels.data()+offset+size_t(y)*s.ow,dst.virt_addr[plane]+size_t(y)*dst.stride,s.ow);
  }
  int rc=hbn_vnode_releaseframe(s.node,0,&out);release.active=false;Check(rc,"release GDC output");
  s.failed=false;return result;
}
}

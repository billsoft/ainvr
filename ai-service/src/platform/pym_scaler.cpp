// Copyright AINVR.
#include "pym_scaler.hpp"
#include "media_memory.hpp"
#include <hbn_vpf_data_info.h>
#include <hbn_vpf_interface.h>
#include <hbn_pym_cfg.h>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
namespace ainvr {
namespace {
void Check(int rc,const char* op){if(rc)throw std::runtime_error(std::string(op)+": "+std::to_string(rc));}
int Layer(int w,int h,int ow,int oh){
  if(w<32||h<32||w>4096||h>4096||w%32||h%8||ow<32||oh<32||ow%2||oh%2)return -1;
  for(int i=0;i<6;++i){int rw=(w>>i)&~1,rh=(h>>i)&~1;
    if(ow<=rw&&oh<=rh&&ow*2>rw&&oh*2>rh)return i;}
  return -1;
}
}
struct PymScaler::State {
  int w=0,h=0,ow=0,oh=0;
  hbn_vnode_handle_t node{};hbn_vflow_handle_t flow{};
  hbn_vnode_image_t input{};
  bool allocated=false,opened=false,created=false,started=false,failed=false;
  std::mutex mutex;
  ~State(){
    if(started)hbn_vflow_stop(flow);
    if(opened)hbn_vnode_close(node);
    if(created)hbn_vflow_destroy(flow);
    if(allocated)hb_mem_free_buf(input.buffer.fd[0]);
  }
};
bool PymScaler::Supports(int w,int h,int ow,int oh){return Layer(w,h,ow,oh)>=0;}
PymScaler::PymScaler(int w,int h,int ow,int oh,int id):state_(std::make_unique<State>()){
  int layer=Layer(w,h,ow,oh);
  if(layer<0||(id!=0&&id!=1&&id!=4))throw std::invalid_argument("Unsupported PYM dimensions or hardware id");
  EnsureMediaMemory();auto& s=*state_;s.w=w;s.h=h;s.ow=ow;s.oh=oh;
  int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED|HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF;
  Check(hb_mem_alloc_graph_buf(w,h,MEM_PIX_FMT_NV12,flags,w,h,&s.input.buffer),"allocate PYM input");s.allocated=true;
  pym_cfg_t cfg{};cfg.hw_id=id;cfg.pym_mode=PYM_M2M_MODE;cfg.output_buf_num=3;cfg.fb_buf_num=2;
  // ABI sentinel and automatic context id from installed vp_sensors.h.
  cfg.layer_num_share_prev=-1;cfg.magicNumber=0x12345678;
  auto& c=cfg.chn_ctrl;c.pixel_num_before_sol=2;c.suffix_hb_val=100;c.prefix_hb_val=2;c.suffix_vb_val=10;c.prefix_vb_val=0;
  c.bl_max_layer_en=5;c.src_in_width=w;c.src_in_height=h;c.src_in_stride_y=s.input.buffer.stride;c.src_in_stride_uv=s.input.buffer.stride;
  c.ds_roi_en=1;c.ds_roi_sel[0]=layer?1:0;c.ds_roi_layer[0]=layer?layer-1:0;
  auto& r=c.ds_roi_info[0];r.region_width=(w>>layer)&~1;r.region_height=(h>>layer)&~1;
  r.out_width=ow;r.out_height=oh;r.wstride_y=r.wstride_uv=(ow+15)&~15;r.vstride=oh;
  Check(hbn_vnode_open(HB_PYM,id,-1,&s.node),"open PYM");s.opened=true;
  Check(hbn_vnode_set_attr(s.node,&cfg),"configure PYM");
  Check(hbn_vnode_set_ichn_attr(s.node,0,&cfg),"configure PYM input");
  Check(hbn_vnode_set_ochn_attr(s.node,0,&cfg),"configure PYM output");
  hbn_buf_alloc_attr_t alloc{};alloc.buffers_num=3;alloc.is_contig=1;
  alloc.flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED;
  Check(hbn_vnode_set_ochn_buf_attr(s.node,0,&alloc),"allocate PYM output");
  Check(hbn_vflow_create(&s.flow),"create PYM flow");s.created=true;
  Check(hbn_vflow_add_vnode(s.flow,s.node),"add PYM flow node");
  Check(hbn_vflow_start(s.flow),"start PYM flow");s.started=true;
}
PymScaler::~PymScaler()=default;
Nv12Frame PymScaler::Run(const Nv12Frame& src){
  auto& s=*state_;std::lock_guard lock(s.mutex);
  if(src.width!=s.w||src.height!=s.h||src.pixels.size()!=size_t(s.w)*s.h*3/2)throw std::invalid_argument("Invalid packed NV12 input");
  if(s.failed)throw std::runtime_error("PYM instance failed; recreate before reuse");
  s.failed=true;auto& b=s.input.buffer;
  for(int y=0;y<s.h;++y)std::memcpy(b.virt_addr[0]+size_t(y)*b.stride,src.pixels.data()+size_t(y)*s.w,s.w);
  for(int y=0;y<s.h/2;++y)std::memcpy(b.virt_addr[1]+size_t(y)*b.stride,src.pixels.data()+size_t(s.w)*s.h+size_t(y)*s.w,s.w);
  Check(hb_mem_flush_buf(b.fd[0],0,b.size[0]+b.size[1]),"flush PYM input");
  gettimeofday(&s.input.info.tv,nullptr);
  Check(hbn_vnode_sendframe(s.node,0,&s.input),"submit PYM input");
  hbn_vnode_image_group_t out{};
  Check(hbn_vnode_getframe_group(s.node,0,2000,&out),"receive PYM output");
  struct Release {State& s;hbn_vnode_image_group_t& out;bool active=true;~Release(){if(active)hbn_vnode_releaseframe_group(s.node,0,&out);}} release{s,out};
  auto& dst=out.buf_group.graph_group[0];
  if(dst.width!=s.ow||dst.height!=s.oh||dst.stride<s.ow||!dst.virt_addr[0]||!dst.virt_addr[1])throw std::runtime_error("Invalid PYM output layout");
  Check(hb_mem_invalidate_buf(dst.fd[0],0,dst.size[0]+dst.size[1]),"invalidate PYM output");
  Nv12Frame result{s.ow,s.oh,src.pts,{}};result.pixels.resize(size_t(s.ow)*s.oh*3/2);
  for(int y=0;y<s.oh;++y)std::memcpy(result.pixels.data()+size_t(y)*s.ow,dst.virt_addr[0]+size_t(y)*dst.stride,s.ow);
  for(int y=0;y<s.oh/2;++y)std::memcpy(result.pixels.data()+size_t(s.ow)*s.oh+size_t(y)*s.ow,dst.virt_addr[1]+size_t(y)*dst.stride,s.ow);
  int rc=hbn_vnode_releaseframe_group(s.node,0,&out);release.active=false;
  Check(rc,"release PYM output");s.failed=false;return result;
}
}

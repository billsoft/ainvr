/* Configuration follows the installed official sample_pym; checks constant-image invariance. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "common_utils.h"
#define CHECK(call) do{int e=(call);if(e){fprintf(stderr,"%s: %d\n",#call,e);rc=1;goto cleanup;}}while(0)
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
int main(int argc,char **argv){
  if(argc!=5&&argc!=6)return 2;
  int id=atoi(argv[1]),w=atoi(argv[2]),h=atoi(argv[3]),frames=atoi(argv[4]),rc=0,opened=0,started=0,allocated=0,flow_created=0;
  int probe_8k=argc==6&&!strcmp(argv[5],"--probe-8k")&&w==7680&&h==3840;
  if((id!=0&&id!=1&&id!=4)||w<32||h<32||((w>4096||h>4096)&&!probe_8k)||w%32||h%8||frames<1)return 2;
  hbn_vnode_handle_t node=0;hbn_vflow_handle_t flow=0;
  hbn_vnode_image_t input={0};pym_cfg_t cfg={0};
  CHECK(hb_mem_module_open());
  int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED|HB_MEM_USAGE_GRAPHIC_CONTIGUOUS_BUF;
  CHECK(hb_mem_alloc_graph_buf(w,h,MEM_PIX_FMT_NV12,flags,w,h,&input.buffer));allocated=1;
  memset(input.buffer.virt_addr[0],73,input.buffer.size[0]);memset(input.buffer.virt_addr[1],128,input.buffer.size[1]);
  CHECK(hb_mem_flush_buf(input.buffer.fd[0],0,input.buffer.size[0]+input.buffer.size[1]));
  cfg.hw_id=id;cfg.pym_mode=PYM_M2M_MODE;cfg.output_buf_num=3;cfg.fb_buf_num=2;
  cfg.layer_num_share_prev=-1;cfg.magicNumber=MAGIC_NUMBER;
  cfg.chn_ctrl.pixel_num_before_sol=DEF_PIX_NUM_BF_SOL;
  cfg.chn_ctrl.suffix_hb_val=DEF_SUFFIX_HB;cfg.chn_ctrl.prefix_hb_val=DEF_PREFIX_HB;
  cfg.chn_ctrl.suffix_vb_val=DEF_SUFFIX_VB;cfg.chn_ctrl.prefix_vb_val=DEF_PREFIX_VB;
  cfg.chn_ctrl.bl_max_layer_en=5;cfg.chn_ctrl.src_in_width=w;cfg.chn_ctrl.src_in_height=h;
  cfg.chn_ctrl.src_in_stride_y=w;cfg.chn_ctrl.src_in_stride_uv=w;
  for(int i=0;i<6;i++){
    if(probe_8k&&i>0)continue;
    int ww=(w>>i)&~1,hh=(h>>i)&~1;if(ww<32||hh<32)continue;
    if(probe_8k){ww=w/2;hh=h/2;cfg.chn_ctrl.bl_max_layer_en=1;}
    cfg.chn_ctrl.ds_roi_en|=1<<i;cfg.chn_ctrl.ds_roi_sel[i]=i?1:0;cfg.chn_ctrl.ds_roi_layer[i]=i?i-1:0;
    if(probe_8k){cfg.chn_ctrl.ds_roi_sel[i]=1;cfg.chn_ctrl.ds_roi_layer[i]=0;}
    roi_box_t *r=&cfg.chn_ctrl.ds_roi_info[i];r->region_width=r->out_width=ww;r->region_height=r->out_height=hh;
    r->wstride_y=r->wstride_uv=(ww+15)&~15;r->vstride=hh;
  }
  CHECK(hbn_vnode_open(HB_PYM,id,AUTO_ALLOC_ID,&node));opened=1;
  CHECK(hbn_vnode_set_attr(node,&cfg));CHECK(hbn_vnode_set_ichn_attr(node,0,&cfg));CHECK(hbn_vnode_set_ochn_attr(node,0,&cfg));
  hbn_buf_alloc_attr_t alloc={.buffers_num=3,.is_contig=1,.flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED};
  CHECK(hbn_vnode_set_ochn_buf_attr(node,0,&alloc));
  CHECK(hbn_vflow_create(&flow));flow_created=1;CHECK(hbn_vflow_add_vnode(flow,node));CHECK(hbn_vflow_start(flow));started=1;
  double total=0,max_ms=0,min_ms=1e9;int channels=0;
  for(int f=0;f<frames+3;f++){
    hbn_vnode_image_group_t out={0};gettimeofday(&input.info.tv,NULL);
    double start=now();CHECK(hbn_vnode_sendframe(node,0,&input));CHECK(hbn_vnode_getframe_group(node,0,2000,&out));
    double elapsed=now()-start;
    if(f>=3){total+=elapsed;if(elapsed*1000>max_ms)max_ms=elapsed*1000;if(elapsed*1000<min_ms)min_ms=elapsed*1000;}
    if(f==0||f==frames+2)for(int i=0;i<6;i++)if(cfg.chn_ctrl.ds_roi_en&(1<<i)){
      hb_mem_graphic_buf_t *b=&out.buf_group.graph_group[i];
      roi_box_t *r=&cfg.chn_ctrl.ds_roi_info[i];
      if(b->width!=r->out_width||b->height!=r->out_height||b->stride<b->width){rc=1;break;}
      if(hb_mem_invalidate_buf(b->fd[0],0,b->size[0]+b->size[1])){rc=1;break;}
      unsigned char *y=b->virt_addr[0],*uv=b->virt_addr[1];
      for(int yy=0;yy<b->height;yy++)for(int xx=0;xx<b->width;xx++)
        if(abs((int)y[yy*b->stride+xx]-73)>1)rc=1;
      for(int yy=0;yy<b->height/2;yy++)for(int xx=0;xx<b->width;xx++)
        if(abs((int)uv[yy*b->stride+xx]-128)>1)rc=1;
      if(f==0){channels++;printf("HWJSON {\"hw_id\":%d,\"channel\":%d,\"width\":%d,\"height\":%d,\"stride\":%d,\"constant_image_checked\":true}\n",id,i,b->width,b->height,b->stride);}
    }
    CHECK(hbn_vnode_releaseframe_group(node,0,&out));if(rc)goto cleanup;
  }
  printf("HWJSON {\"hw_id\":%d,\"frames\":%d,\"channels\":%d,\"width\":%d,\"height\":%d,\"latency_ms_mean\":%.6f,\"latency_ms_min\":%.6f,\"latency_ms_max\":%.6f,\"sequential_fps\":%.3f,\"warmup_frames\":3}\n",id,frames,channels,w,h,total/frames*1000,min_ms,max_ms,frames/total);
cleanup:
  if(started)hbn_vflow_stop(flow);
  if(opened)hbn_vnode_close(node);
  if(flow_created)hbn_vflow_destroy(flow);
  if(allocated)hb_mem_free_buf(input.buffer.fd[0]);
  hb_mem_module_close();return rc;
}

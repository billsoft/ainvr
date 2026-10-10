/* Compile-time SDK inclusion keeps official files intact and records actual completion.
 * No SDK stress script is invoked. GDC's seconds-only timer is replaced below. */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "common_utils.h"
static int errors=0,completed=0;
static double wait_total=0;
static double first_completion=0,last_completion=0;
#if defined(PROBE_CAMERA)
static int frame_limit=0;
static uint32_t previous_frame_id=0;
#endif
static hobot_status measured_get(hbn_vnode_handle_t n,uint32_t c,uint32_t t,hbn_vnode_image_t *i);
static hobot_status measured_group(hbn_vnode_handle_t n,uint32_t c,uint32_t t,hbn_vnode_image_group_t *i);
#define hbn_vnode_getframe measured_get
#define hbn_vnode_getframe_group measured_group
#define main sdk_main
#if defined(PROBE_GDC)
#define run_gdc_stress_test sdk_original_stress
#endif
#include PROBE_SOURCE
#undef main
#undef hbn_vnode_getframe
#undef hbn_vnode_getframe_group
#if defined(PROBE_GDC)
#undef run_gdc_stress_test
#endif
static double hw_now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
static void inspect(hb_mem_graphic_buf_t *b) {
  if(!b->virt_addr[0]||!b->width||!b->height||b->stride<b->width){errors++;return;}
  hb_mem_invalidate_buf(b->fd[0],0,b->size[0]+b->size[1]);
  unsigned char *v=b->virt_addr[0];int lo=255,hi=0;
  for(int y=0;y<b->height;y+=8)for(int x=0;x<b->width;x+=8){int a=v[y*b->stride+x];if(a<lo)lo=a;if(a>hi)hi=a;}
  printf("HWJSON {\"event\":\"frame\",\"width\":%d,\"height\":%d,\"stride\":%d,\"sampled_luma_min\":%d,\"sampled_luma_max\":%d}\n",b->width,b->height,b->stride,lo,hi);
#if !defined(PROBE_CAMERA)
  if(hi==lo)errors++;
#endif
  const char *path=getenv("HW_CAPTURE");
  if(path && completed==
#if defined(PROBE_STITCH)
     5
#else
     1
#endif
     ){
    FILE *f=fopen(path,"wb");if(!f){errors++;return;}
    for(int y=0;y<b->height;y++)if(fwrite(v+y*b->stride,1,b->width,f)!=(size_t)b->width)errors++;
    unsigned char *uv=b->virt_addr[1];
    if(uv)for(int y=0;y<b->height/2;y++)if(fwrite(uv+y*b->stride,1,b->width,f)!=(size_t)b->width)errors++;
    fclose(f);
  }
}
static hobot_status measured_get(hbn_vnode_handle_t n,uint32_t c,uint32_t t,hbn_vnode_image_t *i){
  double s=hw_now();hobot_status r=hbn_vnode_getframe(n,c,t,i);wait_total+=hw_now()-s;
  if(r){errors++;return r;}
  completed++;
  last_completion=hw_now();if(completed==1)first_completion=last_completion;
#if defined(PROBE_CAMERA)
  if(completed>1 && i->info.frame_id<=previous_frame_id)errors++;
  previous_frame_id=i->info.frame_id;
  if(completed>=frame_limit)running=0;
#endif
  if(completed<=5)inspect(&i->buffer);return r;
}
static hobot_status measured_group(hbn_vnode_handle_t n,uint32_t c,uint32_t t,hbn_vnode_image_group_t *i){
  double s=hw_now();hobot_status r=hbn_vnode_getframe_group(n,c,t,i);wait_total+=hw_now()-s;
  if(r){errors++;return r;}
  completed++;if(completed<=3)inspect(&i->buf_group.graph_group[0]);return r;
}
int main(int argc,char **argv){
#if defined(PROBE_CAMERA)
  if(argc==2 && !strcmp(argv[1],"--list")){print_help();return 0;}
  const char *limit=getenv("HW_FRAMES");frame_limit=limit?atoi(limit):30;
  if(frame_limit<1||frame_limit>1000)return 2;
#endif
#if defined(PROBE_GDC)
  /* Use official configuration/cleanup helpers, but no integer-second division. */
  if(argc!=5)return 2;
  gdc_info_s g={0};g.input_width=g.output_width=1920;g.input_height=g.output_height=1080;
  g.gdc_bin_file=argv[1];g.input_file=argv[2];g.output_file=argv[3];g.count=atoi(argv[4]);
  hb_mem_common_buf_t bin={0};hbn_vnode_image_t input={0};int rc=0;
  if(hb_mem_module_open()||read_gdc_config(&g,&bin)||read_nv12_image(&g,&input)||create_start_gdc_vnode(&g,&bin))return 1;
  double start=hw_now();
  for(int j=0;j<g.count;j++)if(run_gdc(&g,&input,j==g.count-1)){rc=1;break;}
  double loop_seconds=hw_now()-start;
  stop_destroy_gdc_vnode(&g);hb_mem_free_buf(input.buffer.fd[0]);hb_mem_free_buf(bin.fd);hb_mem_module_close();
  printf("HWJSON {\"operation\":\"gdc\",\"frames\":%d,\"loop_seconds\":%.6f,\"sequential_fps\":%.3f}\n",completed,loop_seconds,completed/loop_seconds);
#else
  double start=hw_now();int rc=sdk_main(argc,argv);
  printf("HWJSON {\"operation\":\"sdk_pipeline\",\"pipeline_seconds\":%.6f}\n",hw_now()-start);
#if defined(PROBE_CAMERA)
  if(completed!=frame_limit)errors++;
  const char *require_ynr=getenv("HW_REQUIRE_YNR");
  if(require_ynr&&atoi(require_ynr)&&g_scene_type!=PIPELINE_SCENE_ISP_YNR){
    fprintf(stderr,"Selected sensor configuration did not enable ISP1-YNR1-PYM1\n");errors++;
  }
  printf("HWJSON {\"operation\":\"camera\",\"completed_frames\":%d,\"scene_type\":%d,\"frame_arrival_fps\":%.3f,\"timing\":\"completion arrivals; official sample includes 20ms pacing\"}\n",completed,g_scene_type,last_completion>first_completion?(completed-1)/(last_completion-first_completion):0);
#endif
#endif
  printf("HWJSON {\"completed_getframe_calls\":%d,\"interface_wait_seconds\":%.6f,\"errors\":%d,\"note\":\"frame completion and content sanity; not calibrated image-quality acceptance\"}\n",completed,wait_total,errors);
  return rc||errors||completed==0 ? 1 : 0;
}

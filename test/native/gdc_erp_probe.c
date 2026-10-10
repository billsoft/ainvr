/* GDC CUSTOM mapping and bounded DDR -> GDC -> DDR processing.
 * Setup follows installed sample_gdc/3-gdc_static_valid; no GPU API is linked. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include "common_utils.h"
#define CHECK(call) do { int e=(call); if(e){fprintf(stderr,"%s: %d\n",#call,e);rc=1;goto cleanup;} } while(0)
#define REQUIRE(c) do { if(!(c)){fprintf(stderr,"%s: line %d\n",#c,__LINE__);rc=1;goto cleanup;} } while(0)
static double stamp(clockid_t id){struct timespec t;clock_gettime(id,&t);return t.tv_sec+t.tv_nsec/1e9;}
static int compare(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
static int capture(const char*path,hb_mem_graphic_buf_t*b){
  FILE*f=fopen(path,"wb");if(!f)return -1;
  // Contiguous output stores both planes in fd[0]; fd[1] can be -1.
  if(b->fd[1]<0||b->fd[1]==b->fd[0]){
    if(hb_mem_invalidate_buf(b->fd[0],0,b->size[0]+b->size[1])){fclose(f);return -1;}
  }
  for(int p=0;p<2;p++){
    if(b->fd[1]>=0&&b->fd[1]!=b->fd[0]&&hb_mem_invalidate_buf(b->fd[p],0,b->size[p])){fclose(f);return -1;}
    unsigned char*v=b->virt_addr[p];if(!v){fclose(f);return -1;}
    int rows=p?b->height/2:b->height;
    for(int y=0;y<rows;y++)if(fwrite(v+(size_t)y*b->stride,1,b->width,f)!=(size_t)b->width){fclose(f);return -1;}
  }
  return fclose(f);
}
int main(int argc,char**argv){
  if(argc!=9)return 2;
  int iw=atoi(argv[1]),ih=atoi(argv[2]),ow=atoi(argv[3]),oh=atoi(argv[4]),n=atoi(argv[5]),step=atoi(argv[8]);
  if(iw<96||ih<96||ow<96||oh<96||iw>3840||ih>2160||ow>3840||oh>2160||iw%16||ow%16||ih%2||oh%2||n<2||n>1000||step<1||step>64)return 2;
  int rc=0,mem=0,opened=0,started=0,allocated=0,bin_allocated=0,flow_created=0;
  FILE*f=NULL;void*generated=NULL;point_t*points=NULL;unsigned char*host=NULL;double*times=NULL;
  hbn_vnode_handle_t node=0;hbn_vflow_handle_t flow=0;
  hb_mem_common_buf_t bin={0};hbn_vnode_image_t input={0};
  size_t count=(size_t)(ow+1)*(oh+1),bytes=(size_t)iw*ih*3/2;
  points=malloc(count*sizeof(point_t));host=malloc(bytes);times=calloc(n,sizeof(double));REQUIRE(points&&host&&times);
  f=fopen(argv[6],"rb");REQUIRE(f);REQUIRE(fread(points,sizeof(point_t),count,f)==count);REQUIRE(fgetc(f)==EOF);fclose(f);f=NULL;
  f=fopen(argv[7],"rb");REQUIRE(f);REQUIRE(fread(host,1,bytes,f)==bytes);REQUIRE(fgetc(f)==EOF);fclose(f);f=NULL;
  param_t param={0};param.format=FMT_SEMIPLANAR_420;param.in=(resolution_t){iw,ih};param.out=(resolution_t){ow,oh};param.fov=180;param.diameter=ih;
  window_t window={0};window.transform=CUSTOM;window.zoom=1;window.out_r=(rect_t){0,0,ow,oh};window.input_roi_r=(rect_t){0,0,iw,ih};
  window.custom.full_tile_calc=1;window.custom.tile_incr_x=step;window.custom.tile_incr_y=step;
  // The CUSTOM lattice covers pixel-space [0,ow] x [0,oh], including endpoints.
  // Using ow*oh points compresses the map by one pixel over the whole frame.
  window.custom.w=ow;window.custom.h=oh;window.custom.centerx=ow/2.;window.custom.centery=oh/2.;window.custom.points=points;
  uint64_t config_size=0;double generation_start=stamp(CLOCK_MONOTONIC);
  CHECK(hbn_gen_gdc_cfg(&param,&window,1,&generated,&config_size));REQUIRE(generated&&config_size>0&&config_size<UINT32_MAX);
  printf("HWJSON {\"event\":\"gdc_config\",\"transform\":\"CUSTOM\",\"config_bytes\":%lu,\"generation_seconds\":%.6f,\"tile_increment\":%d}\n",config_size,stamp(CLOCK_MONOTONIC)-generation_start,step);
  f=fopen("gdc-erp.bin","wb");REQUIRE(f);REQUIRE(fwrite(generated,1,config_size,f)==config_size);fclose(f);f=NULL;
  CHECK(hb_mem_module_open());mem=1;
  int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED;
  CHECK(hb_mem_alloc_com_buf(config_size,flags,&bin));bin_allocated=1;
  memcpy(bin.virt_addr,generated,config_size);CHECK(hb_mem_flush_buf(bin.fd,0,config_size));
  CHECK(hb_mem_alloc_graph_buf(iw,ih,MEM_PIX_FMT_NV12,flags,iw,ih,&input.buffer));allocated=1;
  for(int p=0;p<2;p++){
    unsigned char*dst=input.buffer.virt_addr[p];unsigned char*src=host+(p?(size_t)iw*ih:0);int rows=p?ih/2:ih;
    for(int y=0;y<rows;y++)memcpy(dst+(size_t)y*input.buffer.stride,src+(size_t)y*iw,iw);
    CHECK(hb_mem_flush_buf(input.buffer.fd[p],0,input.buffer.size[p]));
  }
  gdc_settings_t setting={0};setting.gdc_config.config_addr=bin.phys_addr;setting.gdc_config.config_size=bin.size;
  setting.gdc_config.input_width=iw;setting.gdc_config.input_height=ih;setting.gdc_config.input_stride=iw;
  setting.gdc_config.output_width=ow;setting.gdc_config.output_height=oh;setting.gdc_config.output_stride=ow;setting.gdc_config.total_planes=2;
  setting.binary_ion_id=bin.share_id;setting.binary_offset=bin.offset;setting.magicNumber=MAGIC_NUMBER;
  CHECK(hbn_vnode_open(HB_GDC,0,AUTO_ALLOC_ID,&node));opened=1;
  CHECK(hbn_vnode_set_attr(node,&setting));CHECK(hbn_vnode_set_ichn_attr(node,0,&setting));CHECK(hbn_vnode_set_ochn_attr(node,0,&setting));
  hbn_buf_alloc_attr_t alloc={.buffers_num=3,.is_contig=1,.flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED};
  CHECK(hbn_vnode_set_ochn_buf_attr(node,0,&alloc));CHECK(hbn_vflow_create(&flow));flow_created=1;
  CHECK(hbn_vflow_add_vnode(flow,node));CHECK(hbn_vflow_start(flow));started=1;
  const char*modes[]={"shared_input","cpu_copy_and_flush"};
  for(int mode=0;mode<2;mode++){
    double total=0,cpu_total=0;int completed=0;
    for(int frame=-3;frame<n;frame++){
      hbn_vnode_image_t out={0};gettimeofday(&input.info.tv,NULL);
      double t=stamp(CLOCK_MONOTONIC),ct=stamp(CLOCK_PROCESS_CPUTIME_ID);
      if(mode)for(int p=0;p<2;p++){
        unsigned char*dst=input.buffer.virt_addr[p];unsigned char*src=host+(p?(size_t)iw*ih:0);int rows=p?ih/2:ih;
        for(int y=0;y<rows;y++)memcpy(dst+(size_t)y*input.buffer.stride,src+(size_t)y*iw,iw);
        CHECK(hb_mem_flush_buf(input.buffer.fd[p],0,input.buffer.size[p]));
      }
      CHECK(hbn_vnode_sendframe(node,0,&input));CHECK(hbn_vnode_getframe(node,0,2000,&out));
      double elapsed=stamp(CLOCK_MONOTONIC)-t,cpusec=stamp(CLOCK_PROCESS_CPUTIME_ID)-ct;
      int good=out.buffer.width==ow&&out.buffer.height==oh&&out.buffer.stride>=ow;
      if(good&&(frame==0||frame==n-1)){
        char path[128];snprintf(path,sizeof(path),"%s-%s.nv12",modes[mode],frame==0?"first":"last");good=!capture(path,&out.buffer);
      }
      t=stamp(CLOCK_MONOTONIC);ct=stamp(CLOCK_PROCESS_CPUTIME_ID);CHECK(hbn_vnode_releaseframe(node,0,&out));
      elapsed+=stamp(CLOCK_MONOTONIC)-t;cpusec+=stamp(CLOCK_PROCESS_CPUTIME_ID)-ct;REQUIRE(good);
      if(frame>=0){times[frame]=elapsed;total+=elapsed;cpu_total+=cpusec;completed++;}
    }
    qsort(times,n,sizeof(double),compare);
    printf("HWJSON {\"event\":\"gdc_erp_measurement\",\"mode\":\"%s\",\"hardware\":\"HB_GDC:0\",\"input_width\":%d,\"input_height\":%d,\"output_width\":%d,\"output_height\":%d,\"completed_frames\":%d,\"frame_ms_mean\":%.6f,\"frame_ms_p95\":%.6f,\"fps\":%.3f,\"process_cpu_ms_per_frame\":%.6f,\"warmup_frames\":3}\n",modes[mode],iw,ih,ow,oh,completed,total/n*1000,times[(n-1)*95/100]*1000,n/total,cpu_total/n*1000);
  }
cleanup:
  if(f)fclose(f);if(started)hbn_vflow_stop(flow);if(opened)hbn_vnode_close(node);if(flow_created)hbn_vflow_destroy(flow);
  if(allocated)hb_mem_free_buf(input.buffer.fd[0]);if(bin_allocated)hb_mem_free_buf(bin.fd);if(mem)hb_mem_module_close();
  if(generated)hbn_free_gdc_cfg(generated);free(points);free(host);free(times);return rc;
}

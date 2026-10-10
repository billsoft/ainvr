/* Configuration-only boundary probe. Never starts a flow or submits a frame.
 * Reuses a known-good binary solely to query dimension validation. Acceptance
 * here is not proof of processing support: the binary does not match all sizes. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common_utils.h"
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int rc=1, mem=0, allocated=0;
  FILE *f=fopen(argv[1],"rb"); if(!f) return 2;
  fseek(f,0,SEEK_END); long bytes=ftell(f); rewind(f);
  if(bytes<=0 || bytes>1048576){fclose(f);return 2;}
  unsigned char *data=malloc(bytes); if(!data){fclose(f);return 2;}
  if(fread(data,1,bytes,f)!=(size_t)bytes){fclose(f);free(data);return 2;}
  fclose(f); hb_mem_common_buf_t bin={0};
  if(hb_mem_module_open()) goto done; mem=1;
  int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|
    HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED;
  if(hb_mem_alloc_com_buf(bytes,flags,&bin)) goto done; allocated=1;
  memcpy(bin.virt_addr,data,bytes); if(hb_mem_flush_buf(bin.fd,0,bytes)) goto done;
  const int dims[][4]={{3840,2160,3840,2160},{3840,2160,2160,2160},
    {3840,2160,1920,2176},{3840,2160,3000,3000},{3840,2160,3008,3008},
    {3840,2160,3840,3840},{1920,2176,1920,1080},
    {3000,3000,1920,1080},{3840,3840,1920,1080},
    {3840,2160,2880,2880},{3840,2160,2160,3840},
    {3840,2160,3840,2176},{3840,2160,1920,2304},
    {3840,2160,1920,2592},{3840,2160,1920,2880},
    {3840,2160,1920,2912},{3840,2160,1920,3840},
    {2880,2880,1920,1080},{3840,2160,2176,2176},
    {2176,2176,1920,1080},{2160,3840,1920,1080}};
  int baseline_ok=0;
  for(size_t i=0;i<sizeof(dims)/sizeof(dims[0]);i++){
    hbn_vnode_handle_t node=0; int opened=0;
    gdc_settings_t cfg={0};cfg.magicNumber=MAGIC_NUMBER;
    cfg.binary_ion_id=bin.share_id;cfg.binary_offset=bin.offset;
    cfg.gdc_config.config_addr=bin.phys_addr;cfg.gdc_config.config_size=bin.size;
    cfg.gdc_config.input_width=dims[i][0];cfg.gdc_config.input_height=dims[i][1];
    cfg.gdc_config.output_width=dims[i][2];cfg.gdc_config.output_height=dims[i][3];
    cfg.gdc_config.input_stride=(dims[i][0]+15)&~15;
    cfg.gdc_config.output_stride=(dims[i][2]+15)&~15;cfg.gdc_config.total_planes=2;
    const char *stage="open";int e=hbn_vnode_open(HB_GDC,0,AUTO_ALLOC_ID,&node);
    if(!e){opened=1;stage="set_attr";e=hbn_vnode_set_attr(node,&cfg);}
    if(!e){stage="set_ichn_attr";e=hbn_vnode_set_ichn_attr(node,0,&cfg);}
    if(!e){stage="set_ochn_attr";e=hbn_vnode_set_ochn_attr(node,0,&cfg);}
    printf("HWJSON {\"event\":\"gdc_dimension_config\",\"input\":[%d,%d],"
      "\"output\":[%d,%d],\"stage\":\"%s\",\"return_code\":%d,"
      "\"frames_submitted\":0,\"processing_support_verified\":false}\n",
      dims[i][0],dims[i][1],dims[i][2],dims[i][3],stage,e);
    if(i==0)baseline_ok=!e;
    if(opened && hbn_vnode_close(node)) goto done;
  }
  rc=baseline_ok?0:1;
done:
  if(allocated)hb_mem_free_buf(bin.fd);if(mem)hb_mem_module_close();free(data);
  return rc;
}

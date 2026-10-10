/* Bounded SC132GS experiment using the installed official pipeline helpers.
 * Official sources remain unchanged. No software ISP or encoder fallback. */
#include <time.h>
#include <stdint.h>
#include "common_utils.h"
#ifdef CAMERA_ABI_BRIDGE
static int32_t compatible_camera_create(const camera_config_t*,camera_handle_t*);
#define hbn_camera_create compatible_camera_create
#endif
#define main official_pipeline_main
#ifndef PROBE_SOURCE
#define PROBE_SOURCE "/app/multimedia_samples/sample_pipeline/single_pipe_vin_isp_ynr_pym_vpu/single_pipe_vin_isp_ynr_pym_vpu.c"
#endif
#include PROBE_SOURCE
#undef main
#ifdef CAMERA_ABI_BRIDGE
#undef hbn_camera_create
extern int32_t sc132gs_current_camera_create(uint32_t,camera_handle_t*);
static int32_t compatible_camera_create(const camera_config_t*cfg,camera_handle_t*out){
  if(strcmp(cfg->name,"sc132gs")||cfg->width!=1088||cfg->height!=1280)return -1;
  return sc132gs_current_camera_create(cfg->addr,out);
}
#endif
#include "hbn_api_isp.h"
#define TRY(call) do { int e=(call);if(e){fprintf(stderr,"%s: %d\n",#call,e);rc=1;goto done;} } while(0)
static double now(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
static int invalidate(hb_mem_graphic_buf_t*b){
  if(b->fd[1]<0||b->fd[1]==b->fd[0])return hb_mem_invalidate_buf(b->fd[0],0,b->size[0]+b->size[1]);
  for(int p=0;p<2;p++){int e=hb_mem_invalidate_buf(b->fd[p],0,b->size[p]);if(e)return e;}return 0;
}
static int save_nv12(const char*name,hb_mem_graphic_buf_t*b){
  FILE*f=fopen(name,"wb");if(!f)return -1;
  for(int p=0;p<2;p++)for(int y=0;y<(p?b->height/2:b->height);y++)
    if(fwrite(b->virt_addr[p]+(size_t)y*b->stride,1,b->width,f)!=(size_t)b->width){fclose(f);return -1;}
  return fclose(f);
}
static void telemetry(hbn_vnode_handle_t node,int index){
  ae_info_t ae={0};awb_info_t awb={0};isp_module_ctrl_u ctrl={0};
  opt_mode_e am=OPT_MODE_BUTT,wm=OPT_MODE_BUTT;
  int ar=hbn_isp_get_ae_info(node,&ae),wr=hbn_isp_get_awb_info(node,&awb);
  int mr=hbn_isp_get_module_control(node,&ctrl);
  int agr=hbn_isp_get_algo(node,ISP_ALGO_AE,&am),wgr=hbn_isp_get_algo(node,ISP_ALGO_AWB,&wm);
  printf("HWJSON {\"event\":\"isp_telemetry\",\"index\":%d,\"ae_rc\":%d,\"awb_rc\":%d,"
    "\"module_rc\":%d,\"ae_mode_rc\":%d,\"awb_mode_rc\":%d,\"ae_mode\":%d,\"awb_mode\":%d,"
    "\"exposure\":%u,\"again\":%u,\"dgain\":%u,\"ispgain\":%u,\"exposure_log2\":%u,"
    "\"reported_lux\":%u,\"rgain_q8\":%u,\"bgain_q8\":%u,\"cct\":%u,\"module1\":%u,\"module2\":%u}\n",
    index,ar,wr,mr,agr,wgr,am,wm,ae.ae_exposure,ae.again,ae.dgain,ae.ispgain,
    ae.status_info_exp_log2,ae.cur_lux,awb.rgain,awb.bgain,awb.cct,
    ctrl.isp_module_ctrl_reg1.u32Key,ctrl.isp_module_ctrl_reg2.u32Key);
}
static void receiver_snapshot(int mipi){
  const char*names[]={"info","icnt","regs","clock","user"};
  FILE*out=fopen("mipi-receiver-at-timeout.txt","w");if(!out)return;
  for(unsigned n=0;n<sizeof(names)/sizeof(names[0]);n++){
    char path[160];snprintf(path,sizeof(path),"/sys/class/vps/mipi_host%d/status/%s",mipi,names[n]);
    FILE*in=fopen(path,"r");fprintf(out,"%s\n",path);
    if(!in)continue;char data[8192];size_t bytes=fread(data,1,sizeof(data),in);fwrite(data,1,bytes,out);fclose(in);
  }fclose(out);
}
int main(int argc,char**argv){
  if(argc<6||argc>8)return 2;
  int control_trial=argc>=7?atoi(argv[6]):0;
  int fixed_2a=argc==8?atoi(argv[7]):0;
  if(control_trial&&fixed_2a)return 2;
  int mipi=atoi(argv[1]),limit=atoi(argv[2]);const char*mode=argv[3];
  int sensor_mode=atoi(argv[4]),trigger_duty=atoi(argv[5]);
  if((sensor_mode!=1&&sensor_mode!=6)||trigger_duty<20||trigger_duty>1000)return 2;
  if((mipi!=0&&mipi!=1)||limit<8||limit>900)return 2;
  if(strcmp(mode,"baseline")&&strcmp(mode,"nr2d_only")&&strcmp(mode,"nr3d_only")&&strcmp(mode,"nr_off"))return 2;
  int rc=0,mem=0,started=0,encoder=0,count=0,held=0,enc_initialized=0;
  pipe_contex_t pipe={0};hbn_vnode_image_group_t group={0};FILE*out=NULL;
  uint32_t prev_id=0;uint64_t prev_ts=0;unsigned int gaps=0,duplicates=0;
  double first=0,last=0,begin=now();
  ae_info_t original_ae={0};awb_info_t original_awb={0};
  for(unsigned i=0;i<vp_get_sensors_list_number();i++)
    if(vp_sensor_config_list[i]->chip_id==0x0132){pipe.sensor_config=vp_sensor_config_list[i];break;}
  if(!pipe.sensor_config){rc=1;goto done;}
  pipe.sensor_config->camera_config->sensor_mode=sensor_mode;
  for(unsigned ch=0;ch<4;ch++)
    pipe.sensor_config->vin_node_attr->lpwm_attr.lpwm_chn_attr[ch].duty_time=trigger_duty;
  int used=(1<<0)|(1<<1)|(1<<4);used&=~(1<<mipi);
  TRY(vp_sensor_multi_fixed_mipi_host(pipe.sensor_config,&used,&pipe.csi_config));
  if(pipe.csi_config.mipi_rx!=mipi){rc=1;goto done;}
  if(!pipe.sensor_config->ynr_attr){rc=1;goto done;}
  struct ynr_init_attr *nr=pipe.sensor_config->ynr_attr;
  nr->nr2d_en=strcmp(mode,"nr3d_only")&&strcmp(mode,"nr_off");
  nr->nr3d_en=strcmp(mode,"nr2d_only")&&strcmp(mode,"nr_off");
  nr->nr_static_switch=(nr->nr3d_en<<1)|nr->nr2d_en;
  pipeline_connect_param_init(&pipe,0);
  printf("HWJSON {\"event\":\"pipeline_configuration\",\"mipi\":%d,\"sensor\":\"sc132gs\","
    "\"input_format\":\"RAW10\",\"width\":%u,\"height\":%u,\"configured_fps\":%u,"
    "\"isp_hw\":%d,\"isp_slot\":%d,\"vin_isp_online\":%d,\"ynr_hw\":1,\"nr2d\":%u,\"nr3d\":%u}\n",
    mipi,pipe.sensor_config->camera_config->width,pipe.sensor_config->camera_config->height,
    pipe.sensor_config->camera_config->fps,g_ch_info.isp_hw_id,g_ch_info.isp_slot_id,
    g_ch_info.is_online_vin_isp,nr->nr2d_en,nr->nr3d_en);
  TRY(hb_mem_module_open());mem=1;
  TRY(create_and_run_vflow(&pipe));started=1;
  printf("HWJSON {\"event\":\"sensor_trigger_configuration\",\"sensor_mode\":%d,\"trigger_duty_us\":%d}\n",sensor_mode,trigger_duty);
  int w=pipe.sensor_config->camera_config->width,h=pipe.sensor_config->camera_config->height;
  TRY(vp_encode_config_param(&g_media_context,MEDIA_CODEC_ID_H264,w,h,30,8192));
  g_media_context.video_enc_params.gop_params.gop_preset_idx=9;
  TRY(hb_mm_mc_initialize(&g_media_context));enc_initialized=1;
  TRY(hb_mm_mc_configure(&g_media_context));
  mc_av_codec_startup_params_t startup={0};TRY(hb_mm_mc_start(&g_media_context,&startup));encoder=1;
  out=fopen("camera.h264","wb");if(!out){rc=1;goto done;}
  for(int i=-60;i<limit;i++){
    if(fixed_2a&&i==0){
      ae_info_t ae={0};awb_info_t awb={0};
      TRY(hbn_isp_get_ae_info(pipe.isp_node_handle,&ae));
      TRY(hbn_isp_get_awb_info(pipe.isp_node_handle,&awb));
      ae.ae_exposure=20000;ae.again=128;ae.dgain=0;ae.ispgain=32;
      awb.rgain=256;awb.bgain=256;
      TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AE,OPT_MODE_MANUAL));
      TRY(hbn_isp_set_ae_info(pipe.isp_node_handle,&ae));
      TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AWB,OPT_MODE_MANUAL));
      TRY(hbn_isp_set_awb_info(pipe.isp_node_handle,&awb));
      printf("HWJSON {\"event\":\"fixed_2a_configuration\",\"exposure_native\":20000,\"again_native\":128,\"dgain_native\":0,\"ispgain_native\":32,\"rgain_q8\":256,\"bgain_q8\":256}\n");
    }
    if(control_trial&&i>=0&&i%30==0){
      if(i==0){
        TRY(hbn_isp_get_ae_info(pipe.isp_node_handle,&original_ae));
        TRY(hbn_isp_get_awb_info(pipe.isp_node_handle,&original_awb));
      }else if(i==30||i==60){
        ae_info_t value=original_ae;value.ae_exposure=i==30?500:20000;
        TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AE,OPT_MODE_MANUAL));
        TRY(hbn_isp_set_ae_info(pipe.isp_node_handle,&value));
      }else if(i==90||i==120){
        awb_info_t value=original_awb;value.rgain=i==90?512:128;value.bgain=i==90?128:512;
        TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AWB,OPT_MODE_MANUAL));
        TRY(hbn_isp_set_awb_info(pipe.isp_node_handle,&value));
      }else if(i==150){
        TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AE,OPT_MODE_AUTO));
        TRY(hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AWB,OPT_MODE_AUTO));
      }
      printf("HWJSON {\"event\":\"control_phase\",\"index\":%d}\n",i);
    }
    memset(&group,0,sizeof(group));
    int frame_rc=hbn_vnode_getframe_group(pipe.pym_node_handle,0,2000,&group);
    if(frame_rc){receiver_snapshot(mipi);fprintf(stderr,"getframe_group: %d\n",frame_rc);rc=1;goto done;}held=1;
    hb_mem_graphic_buf_t*b=&group.buf_group.graph_group[0];
    if(b->width!=w||b->height!=h||b->stride<w||!b->virt_addr[0]||!b->virt_addr[1]){rc=1;goto done;}
    if(i>=0){
      last=now();if(i==0)first=last;
      if(i>0){if(group.info.frame_id<=prev_id||group.info.timestamps<=prev_ts)duplicates++;
        else if(group.info.frame_id>prev_id+1)gaps+=group.info.frame_id-prev_id-1;}
      prev_id=group.info.frame_id;prev_ts=group.info.timestamps;
      TRY(invalidate(b));
      double sum=0;int samples=0;
      for(int y=0;y<h;y+=8)for(int x=0;x<w;x+=8){sum+=b->virt_addr[0][(size_t)y*b->stride+x];samples++;}
      if(i==0||i==limit-1||i%15==0||i>=limit-8){
        char name[64];snprintf(name,sizeof(name),"frame-%04d.nv12",i);TRY(save_nv12(name,b));
      }
      media_codec_buffer_t in={0},encoded={0};media_codec_output_buffer_info_t info={0};
      double et=now();TRY(hb_mm_mc_dequeue_input_buffer(&g_media_context,&in,2000));
      if(!in.vframe_buf.vir_ptr[0]||!in.vframe_buf.vir_ptr[1]){rc=1;goto done;}
      in.type=MC_VIDEO_FRAME_BUFFER;in.vframe_buf.width=w;in.vframe_buf.height=h;
      in.vframe_buf.pix_fmt=MC_PIXEL_FORMAT_NV12;in.vframe_buf.size=w*h*3/2;
      for(int p=0;p<2;p++)for(int y=0;y<(p?h/2:h);y++)
        memcpy((unsigned char*)in.vframe_buf.vir_ptr[p]+(size_t)y*w,b->virt_addr[p]+(size_t)y*b->stride,w);
      TRY(hb_mm_mc_queue_input_buffer(&g_media_context,&in,2000));
      TRY(hb_mm_mc_dequeue_output_buffer(&g_media_context,&encoded,&info,2000));
      uint32_t encbytes=encoded.vstream_buf.size;
      int wrote=encoded.vstream_buf.vir_ptr&&encbytes&&
        fwrite(encoded.vstream_buf.vir_ptr,1,encbytes,out)==encbytes;
      TRY(hb_mm_mc_queue_output_buffer(&g_media_context,&encoded,2000));
      if(!wrote){rc=1;goto done;}
      printf("HWJSON {\"event\":\"camera_frame\",\"index\":%d,\"frame_id\":%u,\"timestamp\":%lu,"
        "\"width\":%d,\"height\":%d,\"stride\":%u,\"sampled_luma_mean\":%.6f,"
        "\"encoded_bytes\":%u,\"encoder_copy_completion_ms\":%.6f}\n",
        i,group.info.frame_id,group.info.timestamps,w,h,b->stride,sum/samples,encbytes,(now()-et)*1000);
      if(i%15==0||i==limit-1)telemetry(pipe.isp_node_handle,i);
      count++;
    }
    TRY(hbn_vnode_releaseframe_group(pipe.pym_node_handle,0,&group));held=0;
  }
  printf("HWJSON {\"event\":\"camera_pipeline_result\",\"completed_frames\":%d,"
    "\"frame_id_gaps\":%u,\"nonmonotonic_frames\":%u,\"warmup_frames\":60,"
    "\"arrival_fps\":%.6f,\"elapsed_seconds\":%.6f,\"hardware_encoder\":true}\n",
    count,gaps,duplicates,(limit-1)/(last-first),now()-begin);
  if(duplicates||count!=limit)rc=1;
done:
  if(held)hbn_vnode_releaseframe_group(pipe.pym_node_handle,0,&group);
  if(encoder)hb_mm_mc_pause(&g_media_context);
  if(enc_initialized)hb_mm_mc_release(&g_media_context);
  if(out)fclose(out);
  if(started)hbn_vflow_stop(pipe.vflow_fd);
  if(pipe.pym_node_handle)hbn_vnode_close(pipe.pym_node_handle);
  if(pipe.ynr_node_handle)hbn_vnode_close(pipe.ynr_node_handle);
  if(pipe.isp_node_handle)hbn_vnode_close(pipe.isp_node_handle);
  if(pipe.vin_node_handle)hbn_vnode_close(pipe.vin_node_handle);
  if(pipe.cam_fd)hbn_camera_destroy(pipe.cam_fd);
  if(pipe.vflow_fd)hbn_vflow_destroy(pipe.vflow_fd);
  if(mem)hb_mem_module_close();
  return rc;
}

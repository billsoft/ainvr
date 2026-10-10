/* Bounded Bayer RAW -> physical ISP diagnostic; never substitutes CPU processing.
 * Reuses the official ISP feedback node setup. Direct mode intentionally omits
 * virtual camera/VIN to test whether this firmware supports standalone ISP.
 */
#include "common_utils.h"
#include "hbn_api_isp.h"
#include <time.h>
#define main official_feedback_main
#include PROBE_SOURCE
#undef main

static double monotonic_seconds(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec+t.tv_nsec/1e9;
}
/* The current official GS130 S100 backend passes the complete isp_cfg_t to
 * set_attr. Some older sample code passes only isp_attr_t. Use the complete
 * zero-initialized SDK structure and explicit cache policy for this DIY path. */
static int create_lab_isp(pipe_contex_t *pipe) {
    isp_cfg_t cfg={0};
    cfg.isp_attr=*pipe->sensor_config->isp_attr;
    cfg.isp_attr.channel.hw_id=0;cfg.isp_attr.channel.slot_id=4;
    cfg.isp_attr.channel.ctx_id=AUTO_ALLOC_ID;
    cfg.isp_attr.sched_mode=SCHED_MODE_MANUAL;
    cfg.isp_attr.isp_sw_ctrl.ae_stat_buf_en=1;
    cfg.isp_attr.isp_sw_ctrl.awb_stat_buf_en=1;
    cfg.isp_attr.isp_sw_ctrl.ae5bin_stat_buf_en=1;
    cfg.ichn_attr=*pipe->sensor_config->isp_ichn_attr;
    cfg.ochn_attr=*pipe->sensor_config->isp_ochn_attr;
    cfg.ichn_attr.in_buf_noclean=1;cfg.ichn_attr.in_buf_noncached=0;
    cfg.ochn_attr.out_buf_noinvalid=1;cfg.ochn_attr.out_buf_noncached=0;
    cfg.ochn_attr.axi_output_mode=AXI_OUTPUT_MODE_YUV420;
    cfg.ochn_attr.stream_output_mode=STREAM_OUTPUT_MODE_DISABLE;
    cfg.ochn_attr.buf_num=3;
    int rc=hbn_vnode_open(HB_ISP,0,AUTO_ALLOC_ID,&pipe->isp_node_handle);
    if(rc)return rc;
    if((rc=hbn_vnode_set_attr(pipe->isp_node_handle,&cfg)))return rc;
    if((rc=hbn_vnode_set_ochn_attr(pipe->isp_node_handle,0,&cfg.ochn_attr)))return rc;
    if((rc=hbn_vnode_set_ichn_attr(pipe->isp_node_handle,0,&cfg.ichn_attr)))return rc;
    hbn_buf_alloc_attr_t alloc={.buffers_num=3,.is_contig=1,
        .flags=HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED};
    return hbn_vnode_set_ochn_buf_attr(pipe->isp_node_handle,0,&alloc);
}
static void commands_inventory(hbn_vnode_handle_t node) {
    for(int section=0;section<=4;section++)for(uint32_t command=ISP_CMD_TEST_PATTERN_ENABLE_ID;command<=ISP_CMD_TEST_PATTERN_MODE_ID;command++){
        uint32_t min=0,max=0;isp_cmd_api_t api={.cmd_type=section,.cmd=command,.dir=1};
        int rc=hbn_isp_command(node,&api),range_rc=hbn_isp_get_command_range(node,section,command,&max,&min);
        printf("HWJSON {\"event\":\"ISP_pattern_command_read\",\"section\":%d,\"command\":%u,\"rc\":%d,\"value\":%u,\"range_rc\":%d,\"min\":%u,\"max\":%u}\n",section,command,rc,api.ret_value,range_rc,min,max);
    }
    const uint32_t commands[]={ISP_CMD_SYSTEM_MANUAL_EXPOSURE,
        ISP_CMD_SYSTEM_INTEGRATION_TIME, ISP_CMD_SYSTEM_SENSOR_ANALOG_GAIN,
        ISP_CMD_SYSTEM_SENSOR_DIGITAL_GAIN, ISP_CMD_SYSTEM_ISP_DIGITAL_GAIN,
        ISP_CMD_SYSTEM_SINTER_THRESHOLD_TARGET, ISP_CMD_SYSTEM_AWB_RED_GAIN,
        ISP_CMD_SYSTEM_AWB_BLUE_GAIN, ISP_CMD_ISP_MODULES_MANUAL_BLACK_LEVEL,
        ISP_CMD_ISP_MODULES_MANUAL_DEMOSAIC, ISP_CMD_ISP_MODULES_MANUAL_SINTER};
    for(size_t i=0;i<sizeof(commands)/sizeof(commands[0]);i++) {
        uint32_t min=0,max=0;
        uint32_t section=commands[i]>=ISP_CMD_ISP_MODULES_MANUAL_SINTER?
            ISP_CMD_TYPE_TISP_MODULES:ISP_CMD_TYPE_TSYSTEM;
        isp_cmd_api_t api={.cmd_type=section,.cmd=commands[i],.dir=1};
        int rc=hbn_isp_command(node,&api);
        int range_rc=hbn_isp_get_command_range(node,section,commands[i],&max,&min);
        printf("HWJSON {\"event\":\"ISP_command_read\",\"section\":%u,\"command\":%u,\"rc\":%d,\"value\":%u,\"range_rc\":%d,\"min\":%u,\"max\":%u}\n",
            section,commands[i],rc,api.ret_value,range_rc,min,max);
    }
}
int main(int argc,char **argv) {
    if(argc!=12&&argc!=13) return 2;
    int period_ms=argc==13?atoi(argv[12]):0;
    if(period_ms<0||period_ms>100)return 2;
    int w=atoi(argv[2]),h=atoi(argv[3]),frames=atoi(argv[4]);
    int direct=strcmp(argv[5],"dummy")!=0,bayer=atoi(argv[6]),bypass=atoi(argv[7]);
    int packed=strcmp(argv[10],"unpacked16")!=0,rowbytes=packed?w*5/4:w*2;
    int stride=(rowbytes+31)&~31;
    int red=atoi(argv[8]),blue=atoi(argv[9]);
    if((strcmp(argv[5],"dummy")&&strcmp(argv[5],"direct")&&strcmp(argv[5],"direct_algorithms")) ||
       (strcmp(argv[10],"unpacked16")&&strcmp(argv[10],"mipi_raw10")&&strcmp(argv[10],"bitstream_lsb10")&&strcmp(argv[10],"bitstream_msb10")) || w<256||w>4096||w%32||h<128||h>2160||h%8||
       frames<1||frames>60||bayer<0||bayer>3||bypass < -1||bypass>31||
       red<0||red>1023||blue<0||blue>1023||(!!red != !!blue)) return 2;
    pipe_contex_t pipe={0}; pipe.sensor_config=&dummy_sensor_config;
    vp_sensor_config_t *s=pipe.sensor_config;
    if(strcmp(argv[11],"disable")&&strcmp(argv[11],"lib_sc132gs_linear.so"))return 2;
    if(direct&&strcmp(argv[11],"disable"))return 2;
    snprintf(s->camera_config->calib_lname,sizeof(s->camera_config->calib_lname),"%s",argv[11]);
    s->camera_config->width=w;s->camera_config->height=h;s->camera_config->format=10;
    s->vin_ichn_attr->width=w;s->vin_ichn_attr->height=h;s->vin_ichn_attr->format=0x2b;
    s->vin_ochn_attr->vin_basic_attr.wstride=stride;s->vin_ochn_attr->vin_basic_attr.vstride=h;
    s->vin_ochn_attr->vin_basic_attr.pack_mode=packed?1:0;
    s->isp_attr->size.width=w;s->isp_attr->size.height=h;
    s->isp_attr->algo_state=!strcmp(argv[5],"direct")?0:1;
    cJSON *json=cJSON_Parse(s->camera_config->sensor_param);
    if(!json) return 2;
    cJSON *tuning=cJSON_GetObjectItem(json,"tuning_data");
    cJSON *start=cJSON_GetObjectItem(tuning,"bayer_start");
    if(!start){cJSON_Delete(json);return 2;}
    cJSON_SetIntValue(start,bayer);
    char *sensor_json=cJSON_PrintUnformatted(json);cJSON_Delete(json);
    if(!sensor_json)return 2;
    s->camera_config->sensor_param=sensor_json;
    hbn_vnode_image_t input={0};hbn_vnode_image_group_t output={0};
    int rc=0,done=0,mem=0,flow=0,started=0,cam=0,vin=0,isp=0,allocated=0,held=0,pattern_changed=0;
    uint32_t previous_pattern=0;
    const char *stage="open_RAW";FILE *raw=fopen(argv[1],"rb");
    if(!raw){free(sensor_json);return 2;}
    fseek(raw,0,SEEK_END);long length=ftell(raw);rewind(raw);
    if(length!=(long)rowbytes*h){fclose(raw);free(sensor_json);return 2;}
#define TRY(label,expression) do {stage=label;rc=(expression);if(rc)goto cleanup;} while(0)
    TRY("hbmem_open",hb_mem_module_open());mem=1;
    if(!direct) {
        TRY("virtual_camera_create",create_camera_node(&pipe));cam=1;
        TRY("virtual_VIN_create",create_vin_node(&pipe));vin=1;
    }
    TRY("ISP_create",create_lab_isp(&pipe));isp=1;
    TRY("flow_create",hbn_vflow_create(&pipe.vflow_fd));flow=1;
    if(vin) TRY("flow_add_VIN",hbn_vflow_add_vnode(pipe.vflow_fd,pipe.vin_node_handle));
    TRY("flow_add_ISP",hbn_vflow_add_vnode(pipe.vflow_fd,pipe.isp_node_handle));
    if(cam) TRY("camera_attach_VIN",hbn_camera_attach_to_vin(pipe.cam_fd,pipe.vin_node_handle));
    TRY("flow_start",hbn_vflow_start(pipe.vflow_fd));started=1;
    isp_module_ctrl_u initial_control={0};
    int initial_control_rc=hbn_isp_get_module_control(pipe.isp_node_handle,&initial_control);
    printf("HWJSON {\"event\":\"ISP_initial_control\",\"rc\":%d,\"register1\":%u,\"register2\":%u,\"calibration\":\"%s\"}\n",initial_control_rc,initial_control.isp_module_ctrl_reg1.u32Key,initial_control.isp_module_ctrl_reg2.u32Key,argv[11]);
    commands_inventory(pipe.isp_node_handle);
    if(getenv("RAW_ISP_FREEZE_ALGORITHMS")){
        awb_info_t value={0};
        TRY("AE_manual_for_fixture",hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AE,OPT_MODE_MANUAL));
        TRY("AWB_fixture_get",hbn_isp_get_awb_info(pipe.isp_node_handle,&value));
        TRY("AWB_manual_for_fixture",hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AWB,OPT_MODE_MANUAL));
        value.rgain=256;value.bgain=256;
        TRY("AWB_unity_for_fixture",hbn_isp_set_awb_info(pipe.isp_node_handle,&value));
        printf("HWJSON {\"event\":\"synthetic_algorithms_frozen\",\"AE_manual\":true,\"AWB_unity_Q4_8\":256}\n");
    }
    const char*sinter_target=getenv("RAW_ISP_SINTER_TARGET");
    if(sinter_target){
        int target=atoi(sinter_target);uint32_t min=0,max=0;
        TRY("Sinter_target_range",hbn_isp_get_command_range(pipe.isp_node_handle,ISP_CMD_TYPE_TSYSTEM,ISP_CMD_SYSTEM_SINTER_THRESHOLD_TARGET,&max,&min));
        if(target<0||(uint32_t)target<min||(uint32_t)target>max){rc=-1;goto cleanup;}
        isp_cmd_api_t command={.cmd_type=ISP_CMD_TYPE_TISP_MODULES,.cmd=ISP_CMD_ISP_MODULES_MANUAL_SINTER,.dir=0,.set_value=0};
        TRY("Sinter_firmware_control",hbn_isp_command(pipe.isp_node_handle,&command));
        command.cmd_type=ISP_CMD_TYPE_TSYSTEM;command.cmd=ISP_CMD_SYSTEM_SINTER_THRESHOLD_TARGET;command.set_value=target;
        TRY("Sinter_target_set",hbn_isp_command(pipe.isp_node_handle,&command));
        command.dir=1;TRY("Sinter_target_readback",hbn_isp_command(pipe.isp_node_handle,&command));
        if(command.ret_value!=(uint32_t)target){rc=-1;goto cleanup;}
        printf("HWJSON {\"event\":\"Sinter_firmware_target\",\"manual_module\":false,\"requested\":%d,\"readback\":%u,\"min\":%u,\"max\":%u}\n",target,command.ret_value,min,max);
    }
    if(getenv("RAW_ISP_TEST_PATTERN")){
        isp_cmd_api_t command={.cmd_type=ISP_CMD_TYPE_TSENSOR,.cmd=ISP_CMD_TEST_PATTERN_ENABLE_ID,.dir=1};
        TRY("ISP_test_pattern_original",hbn_isp_command(pipe.isp_node_handle,&command));previous_pattern=command.ret_value;
        command.dir=0;command.set_value=1;
        TRY("ISP_test_pattern_enable",hbn_isp_command(pipe.isp_node_handle,&command));
        pattern_changed=1;
        command.dir=1;TRY("ISP_test_pattern_readback",hbn_isp_command(pipe.isp_node_handle,&command));
        if(command.ret_value!=1){rc=-1;goto cleanup;}
        printf("HWJSON {\"event\":\"ISP_internal_test_pattern\",\"enabled\":true,\"enable_readback\":%u,\"mode\":\"unchanged SDK default\"}\n",command.ret_value);
    }
    printf("HWJSON {\"event\":\"Bayer_configuration\",\"requested_start\":%d,\"sensor_metadata_submitted\":%s,\"note\":\"Direct mode has no sensor metadata; hardware CFA phase is unverified\"}\n",bayer,direct?"false":"true");
    if(bypass>=0) {
        isp_module_ctrl_u ctrl={0},readback={0};
        TRY("module_control_get",hbn_isp_get_module_control(pipe.isp_node_handle,&ctrl));
        int originally_bypassed=!!(ctrl.isp_module_ctrl_reg1.u32Key&(1u<<bypass));
        ctrl.isp_module_ctrl_reg1.u32Key|=1u<<bypass;
        TRY("module_control_set",hbn_isp_set_module_control(pipe.isp_node_handle,&ctrl));
        TRY("module_control_readback",hbn_isp_get_module_control(pipe.isp_node_handle,&readback));
        if(!(readback.isp_module_ctrl_reg1.u32Key&(1u<<bypass))){rc=-1;goto cleanup;}
        printf("HWJSON {\"event\":\"module_control_readback\",\"bypass_bit\":%d,\"already_bypassed\":%s,\"register1\":%u}\n",bypass,originally_bypassed?"true":"false",readback.isp_module_ctrl_reg1.u32Key);
    }
    if(red) {
        awb_info_t original={0},value={0},back={0};
        TRY("AWB_get",hbn_isp_get_awb_info(pipe.isp_node_handle,&original));value=original;
        TRY("AWB_manual",hbn_isp_set_algo(pipe.isp_node_handle,ISP_ALGO_AWB,OPT_MODE_MANUAL));
        value.rgain=red;value.bgain=blue;
        TRY("AWB_set",hbn_isp_set_awb_info(pipe.isp_node_handle,&value));
        TRY("AWB_readback",hbn_isp_get_awb_info(pipe.isp_node_handle,&back));
        if(abs((int)back.rgain-red)>=2||abs((int)back.bgain-blue)>=2){rc=-1;goto cleanup;}
        printf("HWJSON {\"event\":\"AWB_manual_readback\",\"rgain_Q4_8\":%u,\"bgain_Q4_8\":%u}\n",back.rgain,back.bgain);
    }
    int64_t flags=HB_MEM_USAGE_MAP_INITIALIZED|HB_MEM_USAGE_PRIV_HEAP_2_RESERVERD|
        HB_MEM_USAGE_CPU_READ_OFTEN|HB_MEM_USAGE_CPU_WRITE_OFTEN|HB_MEM_USAGE_CACHED;
    TRY("RAW_allocate",hb_mem_alloc_graph_buf(w,h,MEM_PIX_FMT_RAW10,flags,stride,h,&input.buffer));allocated=1;
    if(input.buffer.stride<stride||!input.buffer.virt_addr[0]){rc=-1;goto cleanup;}
    memset(input.buffer.virt_addr[0],0,input.buffer.size[0]);
    for(int y=0;y<h;y++) if(fread(input.buffer.virt_addr[0]+(size_t)y*input.buffer.stride,1,rowbytes,raw)!=(size_t)rowbytes){rc=-1;goto cleanup;}
    TRY("RAW_flush",hb_mem_flush_buf(input.buffer.fd[0],0,input.buffer.size[0]));
    printf("HWJSON {\"event\":\"RAW_input_buffer\",\"stride\":%u,\"vstride\":%u,\"size\":%lu,\"physical\":%lu,\"format\":%d,\"period_ms\":%d}\n",input.buffer.stride,input.buffer.vstride,input.buffer.size[0],input.buffer.phys_addr[0],input.buffer.format,period_ms);
    double begin=monotonic_seconds();
    for(int frame=0;frame<frames;frame++) {
        input.info.frame_id=frame+1;
        double frame_begin=monotonic_seconds();
        TRY("ISP_send_RAW",hbn_vnode_sendframe(pipe.isp_node_handle,0,&input));
        TRY("ISP_get_YUV",hbn_vnode_getframe_group(pipe.isp_node_handle,0,2000,&output));held=1;
        double node_completion_ms=(monotonic_seconds()-frame_begin)*1000;
        hb_mem_graphic_buf_t *b=&output.buf_group.graph_group[0];
        if(b->width!=w||b->height!=h||b->stride<w||!b->virt_addr[0]||!b->virt_addr[1]){rc=-1;goto cleanup;}
        if(b->is_contig) TRY("YUV_invalidate",hb_mem_invalidate_buf(b->fd[0],0,b->size[0]+b->size[1]));
        else {TRY("Y_invalidate",hb_mem_invalidate_buf(b->fd[0],0,b->size[0]));TRY("UV_invalidate",hb_mem_invalidate_buf(b->fd[1],0,b->size[1]));}
        if(frame==0||frame==frames-1) {
            char filename[64];snprintf(filename,sizeof(filename),"output-%04d.nv12",frame);
            FILE *f=fopen(filename,"wb");if(!f){rc=-1;goto cleanup;}
            int bad=0;
            for(int y=0;y<h;y++) if(fwrite(b->virt_addr[0]+(size_t)y*b->stride,1,w,f)!=(size_t)w)bad=1;
            for(int y=0;y<h/2;y++) if(fwrite(b->virt_addr[1]+(size_t)y*b->stride,1,w,f)!=(size_t)w)bad=1;
            if(fclose(f))bad=1;
            if(bad){rc=-1;goto cleanup;}
        }
        printf("HWJSON {\"event\":\"RAW_ISP_frame\",\"index\":%d,\"input_frame_id\":%u,\"output_frame_id\":%u,\"output_timestamp\":%lu,\"send_get_completion_ms\":%.6f}\n",frame,input.info.frame_id,output.info.frame_id,output.info.timestamps,node_completion_ms);
        TRY("ISP_release_YUV",hbn_vnode_releaseframe_group(pipe.isp_node_handle,0,&output));held=0;done++;
        if(period_ms){struct timespec delay={.tv_sec=0,.tv_nsec=period_ms*1000000L};nanosleep(&delay,NULL);}
    }
    printf("HWJSON {\"event\":\"RAW_ISP_completed\",\"completed_frames\":%d,\"width\":%d,\"height\":%d,\"RAW_bit_depth\":10,\"bayer_start\":%d,\"seconds_including_first_frame_and_capture_writes\":%.6f}\n",done,w,h,bayer,monotonic_seconds()-begin);
cleanup:
    if(pattern_changed){
        isp_cmd_api_t command={.cmd_type=ISP_CMD_TYPE_TSENSOR,.cmd=ISP_CMD_TEST_PATTERN_ENABLE_ID,.dir=0,.set_value=previous_pattern};
        int restore_rc=hbn_isp_command(pipe.isp_node_handle,&command);
        printf("HWJSON {\"event\":\"ISP_pattern_restore\",\"rc\":%d,\"original\":%u}\n",restore_rc,previous_pattern);
        if(restore_rc)rc=restore_rc;
    }
    printf("HWJSON {\"event\":\"RAW_ISP_status\",\"path\":\"%s\",\"stage\":\"%s\",\"rc\":%d,\"completed_frames\":%d}\n",argv[5],stage,rc,done);
    if(held)hbn_vnode_releaseframe_group(pipe.isp_node_handle,0,&output);
    if(started)hbn_vflow_stop(pipe.vflow_fd);
    /* Partial helper failures may leave a valid node handle; close it too. */
    if(isp||pipe.isp_node_handle)hbn_vnode_close(pipe.isp_node_handle);
    if(cam||pipe.cam_fd)hbn_camera_destroy(pipe.cam_fd);
    if(vin||pipe.vin_node_handle)hbn_vnode_close(pipe.vin_node_handle);
    if(flow)hbn_vflow_destroy(pipe.vflow_fd);
    if(allocated)hb_mem_free_buf(input.buffer.fd[0]);
    if(mem)hb_mem_module_close();
    fclose(raw);free(sensor_json);
    return rc||done!=frames?1:0;
}

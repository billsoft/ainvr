/* Bounded physical VIN RAW capture using unmodified official helpers. */
#include "common_utils.h"
#define main official_vin_main
#include PROBE_SOURCE
#undef main
#define CHECK(call) do {int error=(call);if(error){fprintf(stderr,"%s: %d\n",#call,error);rc=1;goto done;}}while(0)
int main(int argc,char**argv){
    if(argc!=3)return 2;
    int mipi=atoi(argv[1]),pack=atoi(argv[2]);
    if((mipi!=0&&mipi!=1)||(pack!=0&&pack!=1))return 2;
    int rc=0,mem=0,started=0,held=0;
    pipe_contex_t pipe={0};hbn_vnode_image_t image={0};
    for(unsigned i=0;i<vp_get_sensors_list_number();i++)
        if(vp_sensor_config_list[i]->chip_id==0x0132){pipe.sensor_config=vp_sensor_config_list[i];break;}
    if(!pipe.sensor_config)return 1;
    int used=((1<<0)|(1<<1)|(1<<4))&~(1<<mipi);
    pipe.sensor_config->camera_config->sensor_mode=1;
    pipe.sensor_config->vin_ochn_attr->vin_basic_attr.pack_mode=pack;
    int w=pipe.sensor_config->camera_config->width,h=pipe.sensor_config->camera_config->height;
    int rowbytes=pack?w*5/4:w*2;
    pipe.sensor_config->vin_ochn_attr->vin_basic_attr.wstride=(rowbytes+31)&~31;
    pipe.sensor_config->vin_ochn_attr->vin_basic_attr.vstride=h;
    CHECK(vp_sensor_multi_fixed_mipi_host(pipe.sensor_config,&used,&pipe.csi_config));
    if(pipe.csi_config.mipi_rx!=mipi){rc=1;goto done;}
    sensor_type=SENSOR_TYPE_NORMAL;date_type=pipe.sensor_config->vin_ichn_attr->format;
    CHECK(hb_mem_module_open());mem=1;
    CHECK(create_and_run_vflow(&pipe));started=1;
    for(int i=-30;i<2;i++){
        CHECK(hbn_vnode_getframe(pipe.vin_node_handle,0,2000,&image));held=1;
        hb_mem_graphic_buf_t*b=&image.buffer;
        if(b->width!=w||b->height!=h||b->stride<rowbytes||!b->virt_addr[0]){rc=1;goto done;}
        if(i>=0){
            CHECK(hb_mem_invalidate_buf(b->fd[0],0,b->size[0]));
            char name[40];snprintf(name,sizeof(name),"sensor-%04d.raw",i);
            FILE*f=fopen(name,"wb");if(!f){rc=1;goto done;}
            int bad=0;
            for(int y=0;y<h;y++)if(fwrite(b->virt_addr[0]+(size_t)y*b->stride,1,rowbytes,f)!=(size_t)rowbytes)bad=1;
            if(fclose(f))bad=1;if(bad){rc=1;goto done;}
            printf("HWJSON {\"event\":\"sensor_RAW_capture\",\"mipi\":%d,\"pack_mode\":%d,\"width\":%d,\"height\":%d,\"stride\":%u,\"file_rowbytes\":%d,\"format\":%d,\"frame_id\":%u,\"timestamp\":%lu}\n",mipi,pack,w,h,b->stride,rowbytes,b->format,image.info.frame_id,image.info.timestamps);
        }
        CHECK(hbn_vnode_releaseframe(pipe.vin_node_handle,0,&image));held=0;
    }
done:
    if(held)hbn_vnode_releaseframe(pipe.vin_node_handle,0,&image);
    if(started)hbn_vflow_stop(pipe.vflow_fd);
    if(pipe.vin_node_handle)hbn_vnode_close(pipe.vin_node_handle);
    if(pipe.cam_fd)hbn_camera_destroy(pipe.cam_fd);
    if(pipe.vflow_fd)hbn_vflow_destroy(pipe.vflow_fd);
    if(mem)hb_mem_module_close();
    return rc;
}

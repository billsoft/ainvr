/* Reuse the board's official configuration helpers; execute bounded native API loops. */
#include <time.h>
#define main official_codec_main
#include "/app/multimedia_samples/sample_codec/sample_codec.c"
#undef main
#define TRY(call) do{int e=(call);if(e){fprintf(stderr,"%s: %d\n",#call,e);rc=1;goto done;}}while(0)
static double mono(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
int main(int argc,char **argv){
  if(argc!=8)return 2;
  int encode=!strcmp(argv[1],"encode"),id=atoi(argv[2]),w=atoi(argv[3]),h=atoi(argv[4]),limit=atoi(argv[5]);
  if(id<0||id>3||w<(id>=2?32:256)||h<(id>=2?32:128)||w%32||h%8||limit<1)return 2;
  media_codec_id_t ids[]={MEDIA_CODEC_ID_H264,MEDIA_CODEC_ID_H265,MEDIA_CODEC_ID_MJPEG,MEDIA_CODEC_ID_JPEG};
  media_codec_context_t context={0};FILE *input=NULL,*output=NULL;
  int rc=0,initialized=0,started=0,count=0;size_t bytes=(size_t)w*h*3/2;
  unsigned char *image=NULL;AVFormatContext *av=NULL;AVPacket *pkt=NULL;
  double total=0,min_ms=1e9,max_ms=0;
  hb_mem_module_open();
  if(encode){
    TRY(vp_encode_config_param(&context,ids[id],w,h,30,12000,
          id==0?"h264_high@L5.2":"h265_main@L5.1",false));
    if(id<2)context.video_enc_params.gop_params.gop_preset_idx=9;
    image=malloc(bytes);if(!image){rc=1;goto done;}
    input=fopen(argv[6],"rb");if(!input||fread(image,1,bytes,input)!=bytes){rc=1;goto done;}
  }else{
    TRY(vp_decode_config_param(&context,ids[id],w,h));
    if(id==0)context.video_dec_params.h264_dec_config.reorder_enable=false;
    if(id==1)context.video_dec_params.h265_dec_config.reorder_enable=false;
    /* .jpg selects image2 by extension, which treats concatenated JPEGs as one
     * image. Explicit MJPEG demuxing preserves one packet per encoded frame. */
    TRY(avformat_open_input(&av,argv[6],id>=2?av_find_input_format("mjpeg"):NULL,NULL));TRY(avformat_find_stream_info(av,NULL));
    pkt=av_packet_alloc();if(!pkt){rc=1;goto done;}
  }
  output=fopen(argv[7],"wb");if(!output){rc=1;goto done;}
  TRY(hb_mm_mc_initialize(&context));initialized=1;TRY(hb_mm_mc_configure(&context));
  mc_av_codec_startup_params_t startup={0};TRY(hb_mm_mc_start(&context,&startup));started=1;
  while(count<limit){
    media_codec_buffer_t in={0},out={0};media_codec_output_buffer_info_t info={0};
    if(!encode){
      int r;do{r=av_read_frame(av,pkt);}while(r>=0&&av->streams[pkt->stream_index]->codecpar->codec_type!=AVMEDIA_TYPE_VIDEO&&(av_packet_unref(pkt),1));
      if(r==AVERROR_EOF)break;if(r<0){rc=1;goto done;}
    }
    double start=mono();TRY(hb_mm_mc_dequeue_input_buffer(&context,&in,2000));
    if(encode){
      in.type=MC_VIDEO_FRAME_BUFFER;in.vframe_buf.width=w;in.vframe_buf.height=h;
      in.vframe_buf.pix_fmt=MC_PIXEL_FORMAT_NV12;in.vframe_buf.size=bytes;
      if(!in.vframe_buf.vir_ptr[0]||!in.vframe_buf.vir_ptr[1]){rc=1;goto done;}
      memcpy(in.vframe_buf.vir_ptr[0],image,w*h);memcpy(in.vframe_buf.vir_ptr[1],image+w*h,w*h/2);
    }else{
      if(pkt->size>context.video_dec_params.bitstream_buf_size){rc=1;goto done;}
      in.type=MC_VIDEO_STREAM_BUFFER;in.vstream_buf.size=pkt->size;in.vstream_buf.stream_end=0;
      memcpy(in.vstream_buf.vir_ptr,pkt->data,pkt->size);av_packet_unref(pkt);
    }
    TRY(hb_mm_mc_queue_input_buffer(&context,&in,2000));
    TRY(hb_mm_mc_dequeue_output_buffer(&context,&out,&info,3000));
    double elapsed=mono()-start;
    if(encode){
      if(!out.vstream_buf.vir_ptr||!out.vstream_buf.size){rc=1;goto release;}
      if(fwrite(out.vstream_buf.vir_ptr,1,out.vstream_buf.size,output)!=out.vstream_buf.size){rc=1;goto release;}
    }else{
      int stride=out.vframe_buf.stride>0?out.vframe_buf.stride:out.vframe_buf.width;
      if(out.vframe_buf.width<w||out.vframe_buf.height<h||stride<w||!out.vframe_buf.vir_ptr[0]||!out.vframe_buf.vir_ptr[1]){rc=1;goto release;}
      if(!getenv("HW_SAMPLE_DECODED")||count==0||count==limit-1){
        for(int y=0;y<h;y++)if(fwrite((char*)out.vframe_buf.vir_ptr[0]+y*stride,1,w,output)!=(size_t)w){rc=1;break;}
        for(int y=0;y<h/2;y++)if(fwrite((char*)out.vframe_buf.vir_ptr[1]+y*stride,1,w,output)!=(size_t)w){rc=1;break;}
      }
    }
release:
    TRY(hb_mm_mc_queue_output_buffer(&context,&out,2000));if(rc)goto done;
    /* Exclude first three frames from steady-state statistics. */
    if(count>=3){total+=elapsed;if(elapsed*1000<min_ms)min_ms=elapsed*1000;if(elapsed*1000>max_ms)max_ms=elapsed*1000;}
    count++;
  }
  if(count!=limit){fprintf(stderr,"expected %d frames, got %d\n",limit,count);rc=1;goto done;}
  printf("HWJSON {\"operation\":\"%s\",\"codec_index\":%d,\"width\":%d,\"height\":%d,\"completed_frames\":%d,\"warmup_frames\":%d,\"latency_ms_mean\":%.6f,\"latency_ms_min\":%.6f,\"latency_ms_max\":%.6f,\"sequential_fps\":%.3f,\"timing\":\"buffer dequeue, CPU copy, submit and hardware completion; excludes file writes\"}\n",
         encode?"encode":"decode",id,w,h,count,count>3?3:count,
         count>3?total/(count-3)*1000:0,count>3?min_ms:0,count>3?max_ms:0,total>0?(count-3)/total:0);
done:
  if(started)hb_mm_mc_pause(&context);
  if(initialized)hb_mm_mc_release(&context);
  if(output)fclose(output);if(input)fclose(input);free(image);
  if(pkt)av_packet_free(&pkt);if(av)avformat_close_input(&av);
  hb_mem_module_close();return rc;
}

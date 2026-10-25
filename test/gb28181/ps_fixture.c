/* Test-only TS -> PS remuxer. No decoding or video encoding. Input is an
 * independently prepared FFmpeg MPEG-TS fixture; output is length/PTS records. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "mpeg-ts.h"
#include "mpeg-ps.h"
void Assert_Throw(int failed,const char *exp,const char *func,const char *file,int line,const char *message){
 (void)exp;(void)func;(void)file;(void)line;(void)message;if(failed)abort();
}
struct state { struct ps_muxer_t *ps; int streams[256]; int64_t pts; FILE *audio; int audio_stream; int64_t audio_pts; };
static void *allocate(void *p,size_t n){(void)p;return malloc(n);}
static void release(void *p,void *b){(void)p;free(b);}
static void be32(uint32_t n){unsigned char b[4]={n>>24,n>>16,n>>8,n};fwrite(b,1,4,stdout);}
static int output(void *p,int stream,void *packet,size_t bytes){
 (void)stream;struct state *s=p;if(bytes>1048576)return -1;
 be32((uint32_t)s->pts);be32((uint32_t)bytes);return fwrite(packet,1,bytes,stdout)==bytes?0:-1;
}
static int frame(void *p,int program,int stream,int codec,int flags,int64_t pts,int64_t dts,const void *data,size_t size){
 (void)program;(void)stream;struct state *s=p;
 if(codec<0||codec>255)return -1;
 if(!s->streams[codec])s->streams[codec]=ps_muxer_add_stream(s->ps,codec,NULL,0);
 if(s->streams[codec]<=0)return -1;s->pts=pts;
 int result=ps_muxer_input(s->ps,s->streams[codec],flags,pts,dts,data,size);
 if(s->audio){
  if(!s->audio_pts)s->audio_pts=pts;
  while(s->audio_pts<=pts){
   unsigned char bytes[160];size_t n=fread(bytes,1,160,s->audio);
   if(n!=160){rewind(s->audio);n=fread(bytes,1,160,s->audio);if(n!=160)return -1;}
   s->pts=s->audio_pts;result=ps_muxer_input(s->ps,s->audio_stream,0,s->audio_pts,s->audio_pts,bytes,160);s->audio_pts+=1800;
   if(result<0)return result;
  }
 }
 return result;
}
int main(int argc,char **argv){
 struct state s={0};struct ps_muxer_func_t callbacks={allocate,release,output};
 s.ps=ps_muxer_create(&callbacks,&s);if(!s.ps)return 1;
 if(argc==3){s.audio=fopen(argv[1],"rb");if(!s.audio)return 5;s.audio_stream=ps_muxer_add_stream(s.ps,atoi(argv[2]),NULL,0);}
 struct ts_demuxer_t *ts=ts_demuxer_create(frame,&s);if(!ts)return 2;
 unsigned char packet[188];while(fread(packet,1,188,stdin)==188)if(ts_demuxer_input(ts,packet,188)<0)return 3;
 ts_demuxer_destroy(ts);ps_muxer_destroy(s.ps);if(s.audio)fclose(s.audio);return ferror(stdout)?4:0;
}

#include "gles_context.h"
#include <math.h>
#include <stdint.h>
#include <time.h>
#define REQUIRE(c) do{if(!(c)){fprintf(stderr,"%s failed at line %d\n",#c,__LINE__);exit(1);}}while(0)
typedef struct{int iw,ih,ow,oh,c,levels;GLuint src,dst,fbo;unsigned char *input,*output;} plane;
static double wall(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
static double cpu(void){struct timespec t;clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t);return t.tv_sec+t.tv_nsec/1e9;}
static void check_gl(void){GLenum e=glGetError();if(e){fprintf(stderr,"GL error 0x%x\n",e);exit(1);}}
static char *load(const char *path){FILE*f=fopen(path,"rb");REQUIRE(f);fseek(f,0,SEEK_END);long n=ftell(f);rewind(f);char*s=calloc(n+1,1);REQUIRE(s);REQUIRE(fread(s,1,n,f)==(size_t)n);fclose(f);return s;}
static GLuint compile(const char *path,GLenum type,const char *define){char*s=load(path);GLuint shader=glCreateShader(type);if(define){char*rest=strchr(s,'\n');REQUIRE(rest);*rest++=0;const char*parts[]={s,"\n",define,rest};glShaderSource(shader,4,parts,NULL);}else glShaderSource(shader,1,(const char**)&s,NULL);glCompileShader(shader);free(s);GLint ok;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);if(!ok){char log[8192];glGetShaderInfoLog(shader,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);exit(1);}return shader;}
static GLuint program(const char *dir,const char *filter,int integer_scale){char path[1024],define[64];snprintf(path,sizeof(path),"%s/scale.vert",dir);GLuint v=compile(path,GL_VERTEX_SHADER,NULL);snprintf(path,sizeof(path),"%s/%s.frag",dir,filter);snprintf(define,sizeof(define),"#define INTEGER_SCALE %d\n",integer_scale);GLuint f=compile(path,GL_FRAGMENT_SHADER,!strcmp(filter,"area")&&integer_scale?define:NULL);GLuint p=glCreateProgram();glAttachShader(p,v);glAttachShader(p,f);glLinkProgram(p);GLint ok;glGetProgramiv(p,GL_LINK_STATUS,&ok);if(!ok){char log[8192];glGetProgramInfoLog(p,sizeof(log),NULL,log);fprintf(stderr,"%s\n",log);exit(1);}glDeleteShader(v);glDeleteShader(f);return p;}
static void init_plane(plane *p,int w,int h,int ow,int oh,int c,int tri){
  p->iw=w;p->ih=h;p->ow=ow;p->oh=oh;p->c=c;
  p->input=malloc((size_t)w*h*c);p->output=malloc((size_t)ow*oh*c);REQUIRE(p->input&&p->output);
  for(int y=0;y<h;y++)for(int x=0;x<w;x++)for(int k=0;k<c;k++)
    p->input[((size_t)y*w+x)*c+k]=(unsigned char)((x*13+y*7+(x>>3)+(y>>2)+k*53)&255);
  p->levels=1;for(int size=w>h?w:h;size>1;size>>=1)p->levels++;
  GLenum format=c==1?GL_RED:GL_RG,internal=c==1?GL_R8:GL_RG8;
  glGenTextures(1,&p->src);glBindTexture(GL_TEXTURE_2D,p->src);
  glTexStorage2D(GL_TEXTURE_2D,p->levels,internal,w,h);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,tri?GL_LINEAR_MIPMAP_LINEAR:GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
  glTexSubImage2D(GL_TEXTURE_2D,0,0,0,w,h,format,GL_UNSIGNED_BYTE,p->input);
  if(tri)glGenerateMipmap(GL_TEXTURE_2D);
  glGenTextures(1,&p->dst);glBindTexture(GL_TEXTURE_2D,p->dst);glTexStorage2D(GL_TEXTURE_2D,1,internal,ow,oh);
  glGenFramebuffers(1,&p->fbo);glBindFramebuffer(GL_FRAMEBUFFER,p->fbo);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,p->dst,0);
  REQUIRE(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);check_gl();
}
static void upload(plane *p){glBindTexture(GL_TEXTURE_2D,p->src);glTexSubImage2D(GL_TEXTURE_2D,0,0,0,p->iw,p->ih,p->c==1?GL_RED:GL_RG,GL_UNSIGNED_BYTE,p->input);}
static void mipmap(plane *p){glBindTexture(GL_TEXTURE_2D,p->src);glGenerateMipmap(GL_TEXTURE_2D);}
static void render(plane *p,GLint size){glBindFramebuffer(GL_FRAMEBUFFER,p->fbo);glViewport(0,0,p->ow,p->oh);glBindTexture(GL_TEXTURE_2D,p->src);glUniform2f(size,p->ow,p->oh);glDrawArrays(GL_TRIANGLES,0,3);}
static void download(plane *p){glBindFramebuffer(GL_FRAMEBUFFER,p->fbo);glReadPixels(0,0,p->ow,p->oh,p->c==1?GL_RED:GL_RG,GL_UNSIGNED_BYTE,p->output);}
static void save(const char *path,plane *p,int input){FILE*f=fopen(path,"wb");REQUIRE(f);for(int i=0;i<2;i++){size_t bytes=input?(size_t)p[i].iw*p[i].ih*p[i].c:(size_t)p[i].ow*p[i].oh*p[i].c;REQUIRE(fwrite(input?p[i].input:p[i].output,1,bytes,f)==bytes);}fclose(f);}
static void save_mip(const char *path,plane *p,int level){FILE*f=fopen(path,"wb");REQUIRE(f);GLuint fbo;glGenFramebuffers(1,&fbo);glBindFramebuffer(GL_FRAMEBUFFER,fbo);for(int i=0;i<2;i++){int w=p[i].iw>>level,h=p[i].ih>>level;if(w<1)w=1;if(h<1)h=1;size_t n=(size_t)w*h*p[i].c;unsigned char*b=malloc(n);REQUIRE(b);glFramebufferTexture2D(GL_FRAMEBUFFER,GL_COLOR_ATTACHMENT0,GL_TEXTURE_2D,p[i].src,level);REQUIRE(glCheckFramebufferStatus(GL_FRAMEBUFFER)==GL_FRAMEBUFFER_COMPLETE);glReadPixels(0,0,w,h,p[i].c==1?GL_RED:GL_RG,GL_UNSIGNED_BYTE,b);check_gl();REQUIRE(fwrite(b,1,n,f)==n);free(b);}glDeleteFramebuffers(1,&fbo);fclose(f);}
static int compare(const void*a,const void*b){double x=*(const double*)a,y=*(const double*)b;return (x>y)-(x<y);}
int main(int argc,char **argv){
  if(argc!=8)return 2;int w=atoi(argv[1]),h=atoi(argv[2]),ow=atoi(argv[3]),oh=atoi(argv[4]),n=atoi(argv[5]);const char*dir=argv[6],*filter=argv[7];
  int tri=!strcmp(filter,"trilinear");if(!tri&&strcmp(filter,"bilinear")&&strcmp(filter,"area"))return 2;
  if(w%2||h%2||ow%2||oh%2||ow<32||oh<32||w<ow||h<oh||(double)w/ow>8||(double)h/oh>8||n<1||n>1000)return 2;
  hw_gl ctx;REQUIRE(!hw_gl_open(&ctx));GLint limit;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);REQUIRE(w<=limit&&h<=limit);
  glPixelStorei(GL_PACK_ALIGNMENT,1);glPixelStorei(GL_UNPACK_ALIGNMENT,1);glDisable(GL_DITHER);glDisable(GL_BLEND);glDisable(GL_DEPTH_TEST);glDisable(GL_SCISSOR_TEST);
  plane p[2]={0};init_plane(&p[0],w,h,ow,oh,1,tri);init_plane(&p[1],w/2,h/2,ow/2,oh/2,2,tri);
  int integer_scale=(w%ow==0&&h%oh==0&&w/ow==h/oh)?w/ow:0;
  printf("HWJSON {\"event\":\"shader_variant\",\"filter\":\"%s\",\"area_integer_scale\":%d}\n",filter,!strcmp(filter,"area")?integer_scale:0);
  save("input.nv12",p,1);GLuint prog=program(dir,filter,integer_scale);glUseProgram(prog);glUniform1i(glGetUniformLocation(prog,"uInput"),0);
  double lod=log2(fmax((double)w/ow,(double)h/oh));glUniform1f(glGetUniformLocation(prog,"uLod"),lod);GLint size=glGetUniformLocation(prog,"uOutputSize");
  GLuint vao;glGenVertexArrays(1,&vao);glBindVertexArray(vao);glActiveTexture(GL_TEXTURE0);
  PFNGLGETQUERYOBJECTUI64VEXTPROC get_timer=(PFNGLGETQUERYOBJECTUI64VEXTPROC)eglGetProcAddress("glGetQueryObjectui64vEXT");
  int timer=get_timer&&strstr((const char*)glGetString(GL_EXTENSIONS),"GL_EXT_disjoint_timer_query");GLuint query=0;if(timer)glGenQueries(1,&query);
  if(tri){char name[128];int lo=(int)floor(lod),hi=(int)ceil(lod);snprintf(name,sizeof(name),"mip-%d.nv12",lo);save_mip(name,p,lo);if(hi!=lo){snprintf(name,sizeof(name),"mip-%d.nv12",hi);save_mip(name,p,hi);}printf("HWJSON {\"event\":\"mip_levels\",\"lod\":%.9f,\"low\":%d,\"high\":%d}\n",lod,lo,hi);}
  const char *modes[]={"resident_sampling","resident_rebuild_mips","upload_render_download"};
  for(int mode=0;mode<3;mode++){
    if(mode==1&&!tri)continue;double *times=calloc(n,sizeof(double));REQUIRE(times);double total=0,cpu_total=0,gpu_total=0;int valid_timers=0;
    for(int frame=-3;frame<n;frame++){
      if(timer){GLint old_disjoint;glGetIntegerv(GL_GPU_DISJOINT_EXT,&old_disjoint);}
      double t=wall(),ct=cpu();if(mode==2){upload(&p[0]);upload(&p[1]);}
      if(timer)glBeginQuery(GL_TIME_ELAPSED_EXT,query);
      if(tri&&mode!=0){mipmap(&p[0]);mipmap(&p[1]);}
      render(&p[0],size);render(&p[1],size);
      if(timer)glEndQuery(GL_TIME_ELAPSED_EXT);
      if(mode==2){download(&p[0]);download(&p[1]);}
      glFinish();double elapsed=wall()-t,cpusec=cpu()-ct;check_gl();
      GLuint64 ns=0;GLint disjoint=0;if(timer){get_timer(query,GL_QUERY_RESULT,&ns);glGetIntegerv(GL_GPU_DISJOINT_EXT,&disjoint);check_gl();}
      if(frame>=0){times[frame]=elapsed;total+=elapsed;cpu_total+=cpusec;if(timer&&!disjoint&&ns>0){gpu_total+=ns/1e9;valid_timers++;}}
      if(frame==0||frame==n-1){if(mode!=2){download(&p[0]);download(&p[1]);check_gl();}char path[256];snprintf(path,sizeof(path),"%s-%s.nv12",modes[mode],frame==0?"first":"last");save(path,p,0);}
    }
    qsort(times,n,sizeof(double),compare);
    printf("HWJSON {\"event\":\"scale_measurement\",\"filter\":\"%s\",\"mode\":\"%s\",\"input_width\":%d,\"input_height\":%d,\"output_width\":%d,\"output_height\":%d,\"completed_frames\":%d,\"frame_ms_mean\":%.6f,\"frame_ms_p95\":%.6f,\"fps\":%.3f,\"process_cpu_ms_per_frame\":%.6f,\"gpu_timer_available\":%s,\"gpu_timer_valid_frames\":%d,\"gpu_render_or_mips_ms_mean\":%.6f,\"lod\":%.6f,\"warmup_frames\":3}\n",filter,modes[mode],w,h,ow,oh,n,total/n*1000,times[(n-1)*95/100]*1000,n/total,cpu_total/n*1000,timer?"true":"false",valid_timers,valid_timers?gpu_total/valid_timers*1000:-1.,lod);free(times);
  }
  if(timer)glDeleteQueries(1,&query);glDeleteVertexArrays(1,&vao);glDeleteProgram(prog);for(int i=0;i<2;i++){glDeleteTextures(1,&p[i].src);glDeleteTextures(1,&p[i].dst);glDeleteFramebuffers(1,&p[i].fbo);free(p[i].input);free(p[i].output);}hw_gl_close(&ctx);return 0;
}

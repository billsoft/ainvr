// Copyright AINVR. Same [1 2 1] x [1 2 1] / 16 Gaussian for both flow planes.
#include "filters.hpp"
#include "contract.hpp"
#include "platform/gles_context.h"
#include <cstring>
#include <thread>
namespace ainvr::flow {
namespace {
struct Binding {
  EGLDisplay display=eglGetCurrentDisplay();EGLContext context=eglGetCurrentContext();
  EGLSurface draw=eglGetCurrentSurface(EGL_DRAW),read=eglGetCurrentSurface(EGL_READ);
  EGLenum api=eglQueryAPI();
  ~Binding(){
    if(display!=EGL_NO_DISPLAY)eglMakeCurrent(display,draw,read,context);
    else if(auto d=eglGetCurrentDisplay();d!=EGL_NO_DISPLAY)eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
    eglBindAPI(api);
  }
};
const char* shader=R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=16) in;
layout(std430,binding=0) readonly buffer Source {float src[];};
layout(std430,binding=1) writeonly buffer Destination {float dst[];};
uniform int median_filter;
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);int c=int(gl_GlobalInvocationID.z);
  if(p.x>=512||p.y>=384)return;
  float v[9];int n=0;float sum=0.0;
  for(int y=-1;y<=1;++y)for(int x=-1;x<=1;++x){
    ivec2 q=clamp(p+ivec2(x,y),ivec2(0),ivec2(511,383));
    float f=src[c*196608+q.y*512+q.x];v[n++]=f;
    sum+=f*float((x==0?2:1)*(y==0?2:1));
  }
  if(median_filter!=0){
    for(int i=1;i<9;++i)for(int j=i;j>0;--j){
      float a=min(v[j-1],v[j]),b=max(v[j-1],v[j]);v[j-1]=a;v[j]=b;
    }
    dst[c*196608+p.y*512+p.x]=v[4];
  }else dst[c*196608+p.y*512+p.x]=sum/16.0;
})GLSL";
void GlCheck(){if(glGetError()!=GL_NO_ERROR)throw Error(503,"flow_gles_error");}
}
struct Filters::State {
  hw_gl gl{};GLuint program=0,buffers[2]{};std::thread::id owner=std::this_thread::get_id();
  State(){gl.drm_fd=-1;}
  void Bind(){
    if(owner!=std::this_thread::get_id())throw Error(503,"flow_gles_thread");
    if(!eglBindAPI(EGL_OPENGL_ES_API)||!eglMakeCurrent(gl.display,gl.surface,gl.surface,gl.context))
      throw Error(503,"flow_gles_unavailable");
  }
  ~State(){Binding saved;
    if(saved.context==gl.context){saved.display=EGL_NO_DISPLAY;saved.context=EGL_NO_CONTEXT;}
    if(gl.context!=EGL_NO_CONTEXT&&eglMakeCurrent(gl.display,gl.surface,gl.surface,gl.context)){
      glDeleteBuffers(2,buffers);if(program)glDeleteProgram(program);
    }
    hw_gl_close(&gl);
  }
};
Filters::Filters():state_(std::make_unique<State>()){
  Binding saved;auto& s=*state_;
  if(hw_gl_open(&s.gl))throw Error(503,"flow_mali_unavailable");
  GLuint compute=glCreateShader(GL_COMPUTE_SHADER);glShaderSource(compute,1,&shader,nullptr);glCompileShader(compute);
  GLint ok=0;glGetShaderiv(compute,GL_COMPILE_STATUS,&ok);
  if(!ok){glDeleteShader(compute);throw Error(503,"flow_shader_compile");}
  s.program=glCreateProgram();glAttachShader(s.program,compute);glLinkProgram(s.program);glDeleteShader(compute);
  glGetProgramiv(s.program,GL_LINK_STATUS,&ok);if(!ok)throw Error(503,"flow_shader_link");
  glGenBuffers(2,s.buffers);GlCheck();
}
Filters::~Filters()=default;
std::vector<float> Filters::Run(const std::vector<float>& values,int channels,bool median){
  if(values.size()!=size_t(channels)*kPixels)throw Error(503,"flow_filter_shape");
  Binding saved;auto& s=*state_;s.Bind();glUseProgram(s.program);
  for(int i=0;i<2;++i){glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.buffers[i]);
    glBufferData(GL_SHADER_STORAGE_BUFFER,values.size()*sizeof(float),i?nullptr:values.data(),GL_DYNAMIC_COPY);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,i,s.buffers[i]);}
  glUniform1i(glGetUniformLocation(s.program,"median_filter"),median?1:0);
  glDispatchCompute(kWidth/16,kHeight/16,channels);glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT|GL_SHADER_STORAGE_BARRIER_BIT);
  GLsync fence=glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE,0);
  if(!fence)throw Error(503,"flow_gles_fence");
  GLenum wait=glClientWaitSync(fence,GL_SYNC_FLUSH_COMMANDS_BIT,2000000000ULL);glDeleteSync(fence);
  if(wait!=GL_ALREADY_SIGNALED&&wait!=GL_CONDITION_SATISFIED)throw Error(503,"flow_gles_timeout");
  glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.buffers[1]);
  void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,values.size()*sizeof(float),GL_MAP_READ_BIT);
  if(!data)throw Error(503,"flow_gles_readback");
  std::vector<float> out(values.size());std::memcpy(out.data(),data,out.size()*sizeof(float));
  if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw Error(503,"flow_gles_readback");GlCheck();return out;
}
std::vector<float> Filters::Median(const std::vector<float>& bgr){return Run(bgr,3,true);}
std::vector<float> Filters::Gaussian(const std::vector<float>& flow){return Run(flow,2,false);}
}

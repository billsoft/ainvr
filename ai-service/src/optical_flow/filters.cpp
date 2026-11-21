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
layout(std430,binding=1) writeonly buffer Destination {uint dst[];};
uniform int operation;
// Fixed BRIEF-style pixel pairs, radius 4 after the existing GLES median filter.
const ivec4 pairs[64]=ivec4[64](
    ivec4(-4,-1,-1,1), ivec4(-4,4,4,0), ivec4(2,4,0,-1), ivec4(3,-2,1,4),
    ivec4(1,-4,-4,-3), ivec4(1,-2,-2,-4), ivec4(0,2,-4,-1), ivec4(1,-3,1,3),
    ivec4(3,0,-4,3), ivec4(-4,3,4,4), ivec4(3,-2,1,3), ivec4(3,-4,-2,1),
    ivec4(-1,4,0,0), ivec4(-2,0,0,4), ivec4(-2,0,4,4), ivec4(2,-2,-4,1),
    ivec4(-1,-2,2,-2), ivec4(3,4,0,3), ivec4(1,1,4,-3), ivec4(-2,1,2,4),
    ivec4(-1,-4,4,0), ivec4(-2,1,1,-2), ivec4(3,-4,-2,4), ivec4(4,4,0,-3),
    ivec4(0,-1,-1,-4), ivec4(3,-1,-4,-2), ivec4(-3,2,3,4), ivec4(-4,-1,4,4),
    ivec4(-2,-3,2,-3), ivec4(-1,-1,0,3), ivec4(1,-3,1,4), ivec4(-1,1,4,4),
    ivec4(-4,4,4,-3), ivec4(-1,0,2,-1), ivec4(-4,-4,4,-1), ivec4(1,-2,-4,0),
    ivec4(-4,2,4,-1), ivec4(0,4,1,1), ivec4(0,-2,2,2), ivec4(0,2,4,-3),
    ivec4(2,3,-1,-4), ivec4(-3,-1,3,-1), ivec4(2,-2,2,3), ivec4(-1,1,2,3),
    ivec4(-3,-4,-1,3), ivec4(0,4,-3,0), ivec4(3,2,3,-1), ivec4(-4,3,3,-2),
    ivec4(4,3,4,0), ivec4(-3,0,3,2), ivec4(0,0,3,-2), ivec4(-4,-2,1,0),
    ivec4(4,-2,3,4), ivec4(-3,-3,-2,3), ivec4(2,-3,4,1), ivec4(-4,-2,-1,-4),
    ivec4(-4,0,1,-1), ivec4(2,-4,3,2), ivec4(4,4,-1,4), ivec4(-4,0,2,-2),
    ivec4(2,-4,-4,-1), ivec4(-1,-3,-4,-1), ivec4(-1,-4,2,1), ivec4(3,3,-3,-2));
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);int c=int(gl_GlobalInvocationID.z);
  if(p.x>=512||p.y>=384)return;
  if(operation==2){
    if(c>=2){
      // Four patch means and chroma on the target image distinguish similar
      // edge orderings. Sample 4x4 taps strictly within the descriptor radius.
      vec3 sum=vec3(0.0);vec4 quadrants=vec4(0.0);
      for(int yy=0;yy<4;++yy)for(int xx=0;xx<4;++xx){
        ivec2 q=clamp(p+ivec2(2*xx-3,2*yy-3),ivec2(0),ivec2(511,383));
        int j=q.y*512+q.x;
        vec3 rgb=vec3(src[j],src[196608+j],src[393216+j]);
        sum+=rgb;quadrants[(yy/2)*2+xx/2]+=rgb.g;
      }
      vec4 data=c==2?quadrants/4.0:vec4(sum/16.0,0.0);
      uvec4 octets=uvec4(clamp(round(data),vec4(0.0),vec4(255.0)));
      dst[c*196608+p.y*512+p.x]=octets.x|(octets.y<<8)|(octets.z<<16)|(octets.w<<24);
      return;
    }
    uint descriptor=0u;
    for(int bit=0;bit<32;++bit){
      ivec4 ab=pairs[c*32+bit];
      ivec2 a=clamp(p+ab.xy,ivec2(0),ivec2(511,383));
      ivec2 b=clamp(p+ab.zw,ivec2(0),ivec2(511,383));
      if(src[196608+a.y*512+a.x]>src[196608+b.y*512+b.x])
        descriptor |= 1u << uint(bit);
    }
    dst[c*196608+p.y*512+p.x]=descriptor;
    return;
  }
  float v[9];int n=0;float sum=0.0;
  for(int y=-1;y<=1;++y)for(int x=-1;x<=1;++x){
    ivec2 q=clamp(p+ivec2(x,y),ivec2(0),ivec2(511,383));
    float f=src[c*196608+q.y*512+q.x];v[n++]=f;
    sum+=f*float((x==0?2:1)*(y==0?2:1));
  }
  if(operation==1){
    for(int i=1;i<9;++i)for(int j=i;j>0;--j){
      float a=min(v[j-1],v[j]),b=max(v[j-1],v[j]);v[j-1]=a;v[j]=b;
    }
    dst[c*196608+p.y*512+p.x]=floatBitsToUint(v[4]);
  }else dst[c*196608+p.y*512+p.x]=floatBitsToUint(sum/16.0);
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
void Filters::Dispatch(const std::vector<float>& values,int planes,int op,void* output,size_t bytes){
  if(values.size()!=size_t(op==2?3:planes)*kPixels || bytes!=size_t(planes)*kPixels*sizeof(uint32_t))throw Error(503,"flow_filter_shape");
  Binding saved;auto& s=*state_;s.Bind();glUseProgram(s.program);
  for(int i=0;i<2;++i){glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.buffers[i]);
    glBufferData(GL_SHADER_STORAGE_BUFFER,i?bytes:values.size()*sizeof(float),i?nullptr:values.data(),GL_DYNAMIC_COPY);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,i,s.buffers[i]);}
  glUniform1i(glGetUniformLocation(s.program,"operation"),op);
  glDispatchCompute(kWidth/16,kHeight/16,planes);glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT|GL_SHADER_STORAGE_BARRIER_BIT);
  GLsync fence=glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE,0);
  if(!fence)throw Error(503,"flow_gles_fence");
  GLenum wait=glClientWaitSync(fence,GL_SYNC_FLUSH_COMMANDS_BIT,2000000000ULL);glDeleteSync(fence);
  if(wait!=GL_ALREADY_SIGNALED&&wait!=GL_CONDITION_SATISFIED)throw Error(503,"flow_gles_timeout");
  glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.buffers[1]);
  void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
  if(!data)throw Error(503,"flow_gles_readback");
  std::memcpy(output,data,bytes);
  if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw Error(503,"flow_gles_readback");GlCheck();
}
std::vector<float> Filters::Median(const std::vector<float>& bgr){
  std::vector<float> out(bgr.size());Dispatch(bgr,3,1,out.data(),out.size()*sizeof(float));return out;
}
std::vector<float> Filters::Gaussian(const std::vector<float>& flow){
  std::vector<float> out(flow.size());Dispatch(flow,2,0,out.data(),out.size()*sizeof(float));return out;
}
std::vector<uint32_t> Filters::SceneDescriptors(const std::vector<float>& bgr){
  std::vector<uint32_t> out(4*kPixels);Dispatch(bgr,4,2,out.data(),out.size()*sizeof(uint32_t));return out;
}
}

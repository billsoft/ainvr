// Copyright AINVR. CPU work is metadata, allocation and byte transfers only.
#include "face_restore_gles.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <thread>
#include <hobot/dnn/hb_dnn.h>
#include "gles_context.h"
namespace ainvr {
namespace {
std::atomic<uint64_t> prepared_count{0}, blended_count{0}, failures{0};
struct Previous {
  EGLDisplay display=eglGetCurrentDisplay();
  EGLContext context=eglGetCurrentContext();
  EGLSurface draw=eglGetCurrentSurface(EGL_DRAW), read=eglGetCurrentSurface(EGL_READ);
  ~Previous() {
    if(display!=EGL_NO_DISPLAY)eglMakeCurrent(display,draw,read,context);
    else if(auto d=eglGetCurrentDisplay();d!=EGL_NO_DISPLAY)
      eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
  }
};
const char* shader=R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=16) in;
layout(binding=0) uniform highp sampler2D source_image;
layout(std430,binding=0) buffer Canvas { float original[]; };
layout(std430,binding=1) readonly buffer Model { uint model[]; };
layout(std430,binding=2) buffer Image { uint image[]; };
layout(std430,binding=3) buffer Validation { uint invalid; };
uniform int operation,size;
uniform ivec2 source_size;
uniform ivec4 valid;
uniform uvec2 strides;
uniform float blend;
int idx(ivec2 p){return p.y*size+p.x;}
ivec3 sample_source(ivec2 p){return ivec3(roundEven(texelFetch(source_image,
  clamp(p,ivec2(0),source_size-1),0).rgb*255.));}
float cubic(float d){float t=abs(d),a=-.75;
  if(t<=1.)return ((a+2.)*t-(a+3.))*t*t+1.;
  if(t<2.)return ((a*t-5.*a)*t+8.*a)*t-4.*a;return 0.;}
vec4 weights(float t){vec4 v=vec4(cubic(1.+t),cubic(t),cubic(1.-t),0.);
  v.w=1.-v.x-v.y-v.z;return v;}
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);
  if(any(greaterThanEqual(p,ivec2(size))))return;
  int n=idx(p),plane=size*size;
  bool inside=all(greaterThanEqual(p,valid.xy))&&all(lessThan(p,valid.xy+valid.zw));
  if(operation==0){
    ivec3 color=ivec3(128);
    if(inside){
      vec2 uv=(vec2(p-valid.xy)+.5)*vec2(source_size)/vec2(valid.zw)-.5;
      ivec2 base=ivec2(floor(uv));vec2 f=uv-vec2(base);
      ivec4 wx=ivec4(roundEven(weights(f.x)*2048.));
      ivec4 wy=ivec4(roundEven(weights(f.y)*2048.));
      ivec3 sum=ivec3(0);
      for(int y=0;y<4;++y)for(int x=0;x<4;++x)
        sum+=sample_source(base+ivec2(x-1,y-1))*(wx[x]*wy[y]);
      color=clamp((sum+2097152)>>22,ivec3(0),ivec3(255));
    }
    for(int c=0;c<3;++c)original[c*plane+n]=float(color[c])*(1./127.5)-1.;
  }else{
    uvec3 color=uvec3(128u);
    for(int c=0;c<3;++c){
      uint offset=uint(c)*strides.x+uint(p.y)*strides.y+uint(p.x);
      float restored=uintBitsToFloat(model[offset]);
      if(isnan(restored)||isinf(restored)){atomicOr(invalid,1u);restored=0.;}
      if(inside){
        float mixed=restored*blend+original[c*plane+n]*(1.-blend);
        color[c]=uint(clamp((mixed+1.)*127.5,0.,255.));
      }
    }
    image[n]=color.r|(color.g<<8)|(color.b<<16)|(255u<<24);
  }
})GLSL";
struct Context {
  hw_gl gl{};
  GLuint program=0,texture=0,buffers[4]{};
  bool healthy=true;
  Context(){
    Previous previous;
    if(hw_gl_open(&gl)){hw_gl_close(&gl);throw std::runtime_error("Mali restoration context unavailable");}
    GLuint compute=0;
    try {
      compute=glCreateShader(GL_COMPUTE_SHADER);
      glShaderSource(compute,1,&shader,nullptr);glCompileShader(compute);
      GLint ok=0;glGetShaderiv(compute,GL_COMPILE_STATUS,&ok);
      if(!ok){char log[4096]{};glGetShaderInfoLog(compute,sizeof(log),nullptr,log);
        throw std::runtime_error(std::string("Restoration shader: ")+log);}
      program=glCreateProgram();glAttachShader(program,compute);glLinkProgram(program);
      glDeleteShader(compute);compute=0;glGetProgramiv(program,GL_LINK_STATUS,&ok);
      if(!ok)throw std::runtime_error("Restoration shader link failed");
      glGenTextures(1,&texture);glGenBuffers(4,buffers);
      // Bind every active storage block even when the prepare branch does not
      // access the model/output blocks.
      for(int i=0;i<4;++i)Buffer(i,4);
      Check();
    }catch(...){if(compute)glDeleteShader(compute);Clear();throw;}
  }
  void Clear(){
    if(program)glDeleteProgram(program);
    if(texture)glDeleteTextures(1,&texture);
    glDeleteBuffers(4,buffers);hw_gl_close(&gl);
  }
  ~Context(){Previous previous;
    if(eglMakeCurrent(gl.display,gl.surface,gl.surface,gl.context))Clear();
    else hw_gl_close(&gl);
  }
  void Check(){if(auto e=glGetError();e!=GL_NO_ERROR){healthy=false;
    throw std::runtime_error("Restoration GLES error "+std::to_string(e));}}
  void Activate(){if(!eglMakeCurrent(gl.display,gl.surface,gl.surface,gl.context)){
    healthy=false;throw std::runtime_error("Restoration context activation failed");}
    glUseProgram(program);glUniform1i(Uniform("source_image"),0);}
  GLint Uniform(const char* name){return glGetUniformLocation(program,name);}
  void Buffer(int binding,size_t bytes,const void* data=nullptr){
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers[binding]);
    glBufferData(GL_SHADER_STORAGE_BUFFER,bytes,data,GL_DYNAMIC_COPY);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,binding,buffers[binding]);
  }
  void Common(const FaceRestoreInput& in,int operation){
    glUniform1i(Uniform("size"),in.size);glUniform1i(Uniform("operation"),operation);
    glUniform4i(Uniform("valid"),in.valid.x,in.valid.y,in.valid.width,in.valid.height);
  }
  void Dispatch(int size){glDispatchCompute((size+15)/16,(size+15)/16,1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT|GL_BUFFER_UPDATE_BARRIER_BIT);Check();}
  void Read(int binding,void* destination,size_t bytes){
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers[binding]);
    void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
    if(!data){healthy=false;throw std::runtime_error("Restoration GPU readback failed");}
    std::memcpy(destination,data,bytes);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER)){healthy=false;
      throw std::runtime_error("Restoration GPU readback corrupted");}
    Check();
  }
};
Context& Current(){
  static thread_local std::string node;
  static thread_local std::unique_ptr<Context> context;
  const auto value=std::getenv("AINVR_DRM_RENDER_NODE");
  const std::string selected=value?value:"";
  if(!context||node!=selected||!context->healthy){
    auto next=std::make_unique<Context>();context=std::move(next);node=selected;
  }
  return *context;
}
void Validate(const FaceRestoreInput& in){
  if((in.size!=256&&in.size!=512)||in.nchw.size()!=size_t(in.size)*in.size*3||
     in.valid.width<=0||in.valid.height<=0||in.valid.x<0||in.valid.y<0||
     in.valid.x+in.valid.width>in.size||in.valid.y+in.valid.height>in.size)
    throw std::invalid_argument("Invalid restoration canvas contract");
}
std::array<int64_t,4> Layout(const nlohmann::json& d,int size,size_t bytes){
  if(d.at("dtype_id")!=HB_DNN_TENSOR_TYPE_F32||d.at("quantization")!=NONE||
     d.at("shape")!=nlohmann::json::array({1,3,size,size}))
    throw std::invalid_argument("Restoration requires unquantized float32 NCHW output");
  auto v=d.at("byte_strides").get<std::vector<int64_t>>();
  if(v.size()!=4||std::any_of(v.begin(),v.end(),[](auto x){return x<=0||x>8*1024*1024;}))
    throw std::invalid_argument("Restoration byte strides exceed the bounded image contract");
  if(v.size()!=4||bytes==0||bytes>8*1024*1024||d.at("aligned_bytes")!=bytes||
     v[3]!=4||v[2]<int64_t(size)*4||v[1]<v[2]*size||v[0]<v[1]*3||
     v[0]>int64_t(bytes)||v[1]%4||v[2]%4)
    throw std::invalid_argument("Invalid restoration output byte strides");
  return {v[0],v[1],v[2],v[3]};
}
}
FaceRestoreStats GetFaceRestoreStats(){return {prepared_count.load(),blended_count.load(),failures.load(),0};}
FaceRestoreInput PrepareFaceRestoreGles(const cv::Mat& rgba,int size){
  if(rgba.empty()||rgba.type()!=CV_8UC4||(size!=256&&size!=512)||rgba.cols>=size||rgba.rows>=size)
    throw std::invalid_argument("Restoration requires a smaller nonempty RGBA8 face crop");
  const double scale=std::min(double(size)/rgba.cols,double(size)/rgba.rows);
  const int w=std::max(1,int(std::nearbyint(rgba.cols*scale)));
  const int h=std::max(1,int(std::nearbyint(rgba.rows*scale)));
  FaceRestoreInput in{size,{(size-w)/2,(size-h)/2,w,h},std::vector<float>(size_t(size)*size*3)};
  Previous previous;
  try{
    auto& gpu=Current();gpu.Activate();auto packed=rgba.isContinuous()?rgba:rgba.clone();
    glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,gpu.texture);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,rgba.cols,rgba.rows,0,GL_RGBA,GL_UNSIGNED_BYTE,packed.data);
    gpu.Buffer(0,in.nchw.size()*4);gpu.Common(in,0);
    glUniform2i(gpu.Uniform("source_size"),rgba.cols,rgba.rows);
    gpu.Dispatch(size);gpu.Read(0,in.nchw.data(),in.nchw.size()*4);
    ++prepared_count;return in;
  }catch(...){++failures;throw;}
}
cv::Mat FinishFaceRestoreGles(const FaceRestoreInput& in,
    const std::vector<unsigned char>& output,const nlohmann::json& d,double blend){
  Validate(in);if(!std::isfinite(blend))throw std::invalid_argument("Restoration blend must be finite");
  const auto strides=Layout(d,in.size,output.size());
  Previous previous;
  try{
    auto& gpu=Current();gpu.Activate();gpu.Buffer(0,in.nchw.size()*4,in.nchw.data());
    gpu.Buffer(1,output.size(),output.data());gpu.Buffer(2,size_t(in.size)*in.size*4);
    uint32_t invalid=0;gpu.Buffer(3,4,&invalid);gpu.Common(in,1);
    glUniform2ui(gpu.Uniform("strides"),strides[1]/4,strides[2]/4);
    glUniform1f(gpu.Uniform("blend"),float(std::clamp(blend,0.,1.)));
    gpu.Dispatch(in.size);gpu.Read(3,&invalid,4);
    if(invalid)throw std::runtime_error("BPU restoration returned nonfinite image values");
    cv::Mat image(in.size,in.size,CV_8UC4);gpu.Read(2,image.data,image.total()*4);
    ++blended_count;return image;
  }catch(...){++failures;throw;}
}
}

// Copyright AINVR. Qwen review-only RGB8 resize on Mali;no neural/image CPU fallback.
// Matches Pillow 9.3 Resample.c's cubic a=-0.5,scaled support,Q22 coefficients,
// horizontal RGB8 rounding followed by vertical RGB8 rounding. Coefficients
// depend only on image dimensions;CPU never samples or filters input pixels.
// Reference: https://github.com/python-pillow/Pillow/blob/9.3.0/src/libImaging/Resample.c
#pragma once
#include "gles_context.h"
#include "jpeg_encoder.hpp"
#include "gles_preprocess.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>
#include <fstream>

namespace ainvr {
class QwenReviewImagePipeline final {
 public:
  explicit QwenReviewImagePipeline(const std::string& lut_path="/mnt/ainvr-ssd/llm-packages/qwen3vl-4b-review-v3/normalize.f32") {
    Binding saved;
    try {
      if(hw_gl_open(&context_))throw std::runtime_error("Qwen review Mali context unavailable");
      const char* source=Shader();
      GLuint shader=glCreateShader(GL_COMPUTE_SHADER);
      glShaderSource(shader,1,&source,nullptr);glCompileShader(shader);
      GLint ok=0;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
      if(!ok){char log[4096]{};glGetShaderInfoLog(shader,sizeof(log),nullptr,log);glDeleteShader(shader);throw std::runtime_error(log);}
      program_=glCreateProgram();glAttachShader(program_,shader);glLinkProgram(program_);glDeleteShader(shader);
      glGetProgramiv(program_,GL_LINK_STATUS,&ok);
      if(!ok){char log[4096]{};glGetProgramInfoLog(program_,sizeof(log),nullptr,log);throw std::runtime_error(log);}
      glGenTextures(1,&texture_);glGenBuffers(5,buffers_);
            std::array<uint32_t,256> bits{}; std::ifstream lut(lut_path,std::ios::binary);
      lut.read(reinterpret_cast<char*>(bits.data()),sizeof(bits));
      if(!lut || lut.peek()!=std::char_traits<char>::eof())throw std::runtime_error("invalid Qwen normalization table");
      Upload(4,bits.data(),sizeof(bits),GL_STATIC_DRAW);Check();
    }catch(...){Close();throw;}
  }
  ~QwenReviewImagePipeline(){Binding saved;Close();}
  QwenReviewImagePipeline(const QwenReviewImagePipeline&)=delete;
  QwenReviewImagePipeline& operator=(const QwenReviewImagePipeline&)=delete;

  std::vector<float> RunRgba(const std::vector<uint8_t>& rgba,int width,int height) {
    if(owner_!=std::this_thread::get_id())throw std::logic_error("Qwen review GPU thread mismatch");
    if(width<1 || height<1 || width>8192 || height>8192 || rgba.size()!=size_t(width)*height*4)
      throw std::invalid_argument("Qwen review RGB8 dimensions/storage invalid");
    Binding saved;Activate();
    GLint limit=0;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);
    if(width>limit || height>limit)throw std::invalid_argument("Qwen review image exceeds Mali texture limit");
    glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,texture_);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8UI,width,height,0,GL_RGBA_INTEGER,GL_UNSIGNED_BYTE,rgba.data());
    if(width!=width_ || height!=height_){
      auto horizontal=Coefficients(width,896),vertical=Coefficients(height,448);
      x_stride_=horizontal.stride;y_stride_=vertical.stride;
      Upload(0,horizontal.data.data(),horizontal.data.size()*sizeof(int32_t),GL_STATIC_DRAW);
      Upload(1,vertical.data.data(),vertical.data.size()*sizeof(int32_t),GL_STATIC_DRAW);
      width_=width;height_=height;
    }
    Upload(2,nullptr,size_t(896)*height*sizeof(uint32_t),GL_DYNAMIC_COPY);
    constexpr size_t bytes=size_t(1568)*1536*sizeof(float);
    Upload(3,nullptr,bytes,GL_STREAM_READ);
    for(int i=0;i<5;++i)glBindBufferBase(GL_SHADER_STORAGE_BUFFER,GLuint(i),buffers_[i]);
    glUseProgram(program_);
    glUniform2i(glGetUniformLocation(program_,"source_size"),width,height);
    glUniform2i(glGetUniformLocation(program_,"coefficient_stride"),x_stride_,y_stride_);
    glUniform1i(glGetUniformLocation(program_,"axis"),0);
    glDispatchCompute(56,GLuint((height+7)/8),1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
    glUniform1i(glGetUniformLocation(program_,"axis"),1);
    glDispatchCompute(56,56,1);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);Check();
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[3]);
    const void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
    if(!data)throw std::runtime_error("Qwen review GPU output mapping failed");
    std::vector<float> output(1568U*1536);std::memcpy(output.data(),data,bytes);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("Qwen review GPU output invalidated");
    Check();return output;
  }

  std::vector<float> RunNv12(const std::vector<uint8_t>& nv12,int width,int height,bool bt709,bool full_range,bool letterbox=false) {
    if(owner_!=std::this_thread::get_id())throw std::logic_error("Qwen review GPU thread mismatch");
    if(width<1 || height<1 || width>8192 || height>8192 || width%2 || height%2 || nv12.size()!=size_t(width)*height*3/2)
      throw std::invalid_argument("Qwen review NV12 dimensions/storage invalid");
    // Keep the established hardware color conversion at source resolution.
    // Resizing is performed only by the independent Pillow-compatible pass.
    if(!color_)color_=std::make_unique<GlesPreprocessor>();
    ImageTransform t;t.width=width;t.height=height;t.letterbox=false;t.nearest=true;
    t.yuv_bt709=bt709;t.yuv_full_range=full_range;
    if(letterbox&&width!=2*height){
      t.width=896;t.height=448;t.letterbox=true;t.nearest=false;
      return RunRgba(color_->RunNv12Rgba(nv12,width,height,t),896,448);
    }
    return RunRgba(color_->RunNv12Rgba(nv12,width,height,t),width,height);
  }

  std::pair<std::vector<float>,std::vector<uint8_t>> RunTarget(const std::vector<uint8_t>& nv12,int width,int height,const std::array<float,4>& box){
    if(!color_)color_=std::make_unique<GlesPreprocessor>();
    const float cx=(box[0]+box[2])*width/2,cy=(box[1]+box[3])*height/2;
    float w=(box[2]-box[0])*width*1.5f,h=(box[3]-box[1])*height*1.5f;
    w=std::max(w,2*h);h=w/2;
    ImageTransform crop;crop.width=896;crop.height=448;crop.letterbox=false;crop.yuv_bt709=false;crop.yuv_full_range=true;
    crop.source_region=std::array<float,4>{cx-w/2,cy-h/2,w,h};
    auto rgba=color_->RunNv12Rgba(nv12,width,height,crop);
    ImageTransform jpeg;jpeg.width=896;jpeg.height=448;jpeg.letterbox=false;
    auto encoded=color_->RunRgbaJpegNv12(rgba,896,448,jpeg);
    if(!jpeg_)jpeg_=std::make_unique<JpegEncoder>(896,448,90);
    auto bytes=jpeg_->EncodeFullRangeNv12(encoded);
    return {RunRgba(rgba,896,448),std::move(bytes)};
  }
  // Context-only annotation. Neural input remains the untouched target crop.
  std::vector<uint8_t> RunContext(const std::vector<uint8_t>& nv12,int width,int height,
      const std::array<float,4>& target,const std::vector<std::array<float,2>>& region,float approach){
    if(owner_!=std::this_thread::get_id())throw std::logic_error("Context GPU thread mismatch");
    if(region.size()>32)throw std::invalid_argument("Context polygon too large");
    if(!color_)color_=std::make_unique<GlesPreprocessor>();
    ImageTransform t;t.width=896;t.height=448;t.letterbox=true;t.yuv_bt709=false;t.yuv_full_range=true;
    auto rgba=color_->RunNv12Rgba(nv12,width,height,t);
    Binding saved;Activate();
    if(!context_program_){
      const char* source=R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=8) in;
layout(binding=0) uniform highp usampler2D source_image;
layout(std430,binding=2) writeonly buffer Output {uint pixels[];};
uniform vec2 source_size;
uniform vec4 image_rect,target;
uniform vec2 vertices[32];
uniform int count;
uniform float approach;
float segment(vec2 p,vec2 a,vec2 b){vec2 d=b-a;return length(p-a-clamp(dot(p-a,d)/max(dot(d,d),.000001),0.,1.)*d);}
void main(){
 ivec2 ip=ivec2(gl_GlobalInvocationID.xy);if(ip.x>=896||ip.y>=448)return;
 vec2 p=vec2(ip)+.5;uvec4 color=texelFetch(source_image,ip,0);
 vec2 uv=(p-image_rect.xy)/image_rect.zw;
 if(all(greaterThanEqual(uv,vec2(0)))&&all(lessThanEqual(uv,vec2(1)))){
  vec2 q=uv*source_size;float d=1e30;bool inside=false;
  for(int i=0;i<count;i++){vec2 a=vertices[i]*source_size,b=vertices[(i+1)%count]*source_size;d=min(d,segment(q,a,b));if((a.y>q.y)!=(b.y>q.y)&&q.x<(b.x-a.x)*(q.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}
  float scale=image_rect.z/source_size.x;
  if(count>0&&d*scale<1.4)color=uvec4(96,165,250,255);
  else if(count>0&&!inside&&approach>0.&&abs(d-approach*source_size.x)*scale<1.4&&mod(p.x+p.y,12.)<7.)color=uvec4(251,191,36,255);
  vec2 lo=target.xy*source_size,hi=target.zw*source_size;
  float bd=min(min(segment(q,lo,vec2(hi.x,lo.y)),segment(q,vec2(hi.x,lo.y),hi)),min(segment(q,hi,vec2(lo.x,hi.y)),segment(q,vec2(lo.x,hi.y),lo)));
  if(bd*scale<1.4)color=uvec4(52,211,153,255);
 }
 pixels[ip.y*896+ip.x]=color.r|(color.g<<8)|(color.b<<16)|0xff000000u;
})GLSL";
      GLuint shader=glCreateShader(GL_COMPUTE_SHADER);glShaderSource(shader,1,&source,nullptr);glCompileShader(shader);GLint ok=0;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
      if(!ok){glDeleteShader(shader);throw std::runtime_error("Context shader compile failed");}
      context_program_=glCreateProgram();glAttachShader(context_program_,shader);glLinkProgram(context_program_);glDeleteShader(shader);glGetProgramiv(context_program_,GL_LINK_STATUS,&ok);if(!ok)throw std::runtime_error("Context shader link failed");
    }
    glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,texture_);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8UI,896,448,0,GL_RGBA_INTEGER,GL_UNSIGNED_BYTE,rgba.data());
    Upload(2,nullptr,rgba.size(),GL_STREAM_READ);glBindBufferBase(GL_SHADER_STORAGE_BUFFER,2,buffers_[2]);glUseProgram(context_program_);
    const float scale=std::min(896.f/width,448.f/height),w=width*scale,h=height*scale;
    glUniform2f(glGetUniformLocation(context_program_,"source_size"),width,height);
    glUniform4f(glGetUniformLocation(context_program_,"image_rect"),(896-w)/2,(448-h)/2,w,h);
    glUniform4fv(glGetUniformLocation(context_program_,"target"),1,target.data());glUniform1i(glGetUniformLocation(context_program_,"count"),region.size());
    if(!region.empty())glUniform2fv(glGetUniformLocation(context_program_,"vertices[0]"),region.size(),region[0].data());
    glUniform1f(glGetUniformLocation(context_program_,"approach"),approach);glDispatchCompute(56,56,1);glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);Check();
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[2]);const void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,rgba.size(),GL_MAP_READ_BIT);if(!data)throw std::runtime_error("Context readback failed");std::memcpy(rgba.data(),data,rgba.size());if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("Context readback invalid");
    ImageTransform j;j.width=896;j.height=448;j.letterbox=false;auto pixels=color_->RunRgbaJpegNv12(rgba,896,448,j);if(!jpeg_)jpeg_=std::make_unique<JpegEncoder>(896,448,90);return jpeg_->EncodeFullRangeNv12(pixels);
  }
 private:
  std::unique_ptr<JpegEncoder> jpeg_;
  GLuint context_program_=0;
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
  struct Table {int stride;std::vector<int32_t> data;};
  static double Cubic(double x){
    x=std::abs(x);
    if(x<1)return (1.5*x-2.5)*x*x+1;
    if(x<2)return (((x-5)*x+8)*x-4)*-0.5;
    return 0;
  }
  static Table Coefficients(int input,int output){
    const double scale=double(input)/output,filter=std::max(1.0,scale),support=2*filter;
    Table t{int(std::ceil(support))*2+1,{}};
    t.data.resize(size_t(output)*(2+t.stride));
    std::vector<double> weights(size_t(t.stride),0.0);
    for(int i=0;i<output;++i){
      const double center=(i+0.5)*scale;
      const int first=std::max(0,int(center-support+0.5));
      const int count=std::min(input,int(center+support+0.5))-first;
      t.data[2*i]=first;t.data[2*i+1]=count;
      double total=0;
      for(int k=0;k<count;++k){weights[k]=Cubic((k+first-center+0.5)/filter);total+=weights[k];}
      if(total==0)throw std::runtime_error("Qwen review empty resize filter");
      for(int k=0;k<count;++k){
        const double scaled=weights[k]/total*4194304.0;
        t.data[size_t(output)*2+size_t(i)*t.stride+k]=int32_t(scaled+(scaled<0?-0.5:0.5));
      }
    }
    return t;
  }
  void Activate(){
    if(!eglBindAPI(EGL_OPENGL_ES_API)||!eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context))
      throw std::runtime_error("Cannot activate Qwen review Mali preprocessing");
  }
  void Close(){
    if(context_.context!=EGL_NO_CONTEXT){
      if(eglBindAPI(EGL_OPENGL_ES_API)&&eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context)){
        if(context_program_)glDeleteProgram(context_program_);glDeleteBuffers(5,buffers_);if(texture_)glDeleteTextures(1,&texture_);if(program_)glDeleteProgram(program_);
      }
    }
    hw_gl_close(&context_);
  }
  void Upload(int index,const void* data,size_t bytes,GLenum usage){
    GLint64 limit=0;glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE,&limit);
    if(bytes>size_t(limit))throw std::invalid_argument("Qwen review GPU buffer exceeds hardware limit");
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[index]);glBufferData(GL_SHADER_STORAGE_BUFFER,GLsizeiptr(bytes),data,usage);
  }
  static void Check(){const auto e=glGetError();if(e!=GL_NO_ERROR)throw std::runtime_error("Qwen review GLES error "+std::to_string(e));}
  static const char* Shader(){return R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=8) in;
layout(binding=0) uniform highp usampler2D source_image;
layout(std430,binding=0) readonly buffer X {int cx[];};
layout(std430,binding=1) readonly buffer Y {int cy[];};
layout(std430,binding=2) buffer Middle {uint pixels[];};
layout(std430,binding=3) writeonly buffer Output {float values[];};
layout(std430,binding=4) readonly buffer Normalization {uint normalization_bits[];};
uniform ivec2 source_size,coefficient_stride;
uniform int axis;
uvec3 rgb(uint p){return uvec3(p&255u,(p>>8)&255u,(p>>16)&255u);}
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);
  if(p.x>=896 || p.y>=(axis==0?source_size.y:448))return;
  ivec3 sum=ivec3(2097152);
  if(axis==0){
    int first=cx[2*p.x],count=cx[2*p.x+1],offset=1792+p.x*coefficient_stride.x;
    for(int k=0;k<count;++k)sum+=ivec3(texelFetch(source_image,ivec2(first+k,p.y),0).rgb)*cx[offset+k];
    uvec3 v=uvec3(clamp(sum>>22,ivec3(0),ivec3(255)));
    pixels[p.y*896+p.x]=v.x|(v.y<<8)|(v.z<<16);
  }else{
    int first=cy[2*p.y],count=cy[2*p.y+1],offset=896+p.y*coefficient_stride.y;
    for(int k=0;k<count;++k)sum+=ivec3(rgb(pixels[(first+k)*896+p.x]))*cy[offset+k];
    ivec3 v=clamp(sum>>22,ivec3(0),ivec3(255));
    vec3 normalized=vec3(uintBitsToFloat(normalization_bits[v.r]),
                         uintBitsToFloat(normalization_bits[v.g]),
                         uintBitsToFloat(normalization_bits[v.b]));
    int bh=p.y/32,bw=p.x/32,mh=(p.y/16)%2,mw=(p.x/16)%2;
    int row=((bh*28+bw)*2+mh)*2+mw;
    for(int c=0;c<3;++c)for(int t=0;t<2;++t){
      int col=((c*2+t)*16+(p.y%16))*16+p.x%16;
      values[row*1536+col]=normalized[c];
    }
  }
})GLSL";}
  hw_gl context_{};
  GLuint program_=0,texture_=0,buffers_[5]{};
  int width_=0,height_=0,x_stride_=0,y_stride_=0;
  const std::thread::id owner_=std::this_thread::get_id();
  std::unique_ptr<GlesPreprocessor> color_;
};
}

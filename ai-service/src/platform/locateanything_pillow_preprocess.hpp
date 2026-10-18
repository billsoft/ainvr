// Copyright AINVR. LocateAnything-only RGB8 resize on Mali;no neural/image CPU fallback.
// Matches Pillow 9.3 Resample.c's cubic a=-0.5,scaled support,Q22 coefficients,
// horizontal RGB8 rounding followed by vertical RGB8 rounding. Coefficients
// depend only on image dimensions;CPU never samples or filters input pixels.
// Reference: https://github.com/python-pillow/Pillow/blob/9.3.0/src/libImaging/Resample.c
#pragma once
#include "gles_context.h"
#include "gles_preprocess.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>

namespace ainvr {
class LocateAnythingPillowPreprocessor final {
 public:
  LocateAnythingPillowPreprocessor() {
    Binding saved;
    try {
      if(hw_gl_open(&context_))throw std::runtime_error("LocateAnything Mali context unavailable");
      const char* source=Shader();
      GLuint shader=glCreateShader(GL_COMPUTE_SHADER);
      glShaderSource(shader,1,&source,nullptr);glCompileShader(shader);
      GLint ok=0;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
      if(!ok){char log[4096]{};glGetShaderInfoLog(shader,sizeof(log),nullptr,log);glDeleteShader(shader);throw std::runtime_error(log);}
      program_=glCreateProgram();glAttachShader(program_,shader);glLinkProgram(program_);glDeleteShader(shader);
      glGetProgramiv(program_,GL_LINK_STATUS,&ok);
      if(!ok){char log[4096]{};glGetProgramInfoLog(program_,sizeof(log),nullptr,log);throw std::runtime_error(log);}
      glGenTextures(1,&texture_);glGenBuffers(5,buffers_);
      Upload(4,NormalizationBits(),256*sizeof(uint32_t),GL_STATIC_DRAW);Check();
    }catch(...){Close();throw;}
  }
  ~LocateAnythingPillowPreprocessor(){Binding saved;Close();}
  LocateAnythingPillowPreprocessor(const LocateAnythingPillowPreprocessor&)=delete;
  LocateAnythingPillowPreprocessor& operator=(const LocateAnythingPillowPreprocessor&)=delete;

  std::vector<float> RunRgba(const std::vector<uint8_t>& rgba,int width,int height) {
    if(owner_!=std::this_thread::get_id())throw std::logic_error("LocateAnything GPU thread mismatch");
    if(width<1 || height<1 || width>8192 || height>8192 || rgba.size()!=size_t(width)*height*4)
      throw std::invalid_argument("LocateAnything RGB8 dimensions/storage invalid");
    Binding saved;Activate();
    GLint limit=0;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);
    if(width>limit || height>limit)throw std::invalid_argument("LocateAnything image exceeds Mali texture limit");
    glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,texture_);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);
    glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8UI,width,height,0,GL_RGBA_INTEGER,GL_UNSIGNED_BYTE,rgba.data());
    if(width!=width_ || height!=height_){
      auto horizontal=Coefficients(width,448),vertical=Coefficients(height,224);
      x_stride_=horizontal.stride;y_stride_=vertical.stride;
      Upload(0,horizontal.data.data(),horizontal.data.size()*sizeof(int32_t),GL_STATIC_DRAW);
      Upload(1,vertical.data.data(),vertical.data.size()*sizeof(int32_t),GL_STATIC_DRAW);
      width_=width;height_=height;
    }
    Upload(2,nullptr,size_t(448)*height*sizeof(uint32_t),GL_DYNAMIC_COPY);
    constexpr size_t bytes=size_t(3)*448*224*sizeof(float);
    Upload(3,nullptr,bytes,GL_STREAM_READ);
    for(int i=0;i<5;++i)glBindBufferBase(GL_SHADER_STORAGE_BUFFER,GLuint(i),buffers_[i]);
    glUseProgram(program_);
    glUniform2i(glGetUniformLocation(program_,"source_size"),width,height);
    glUniform2i(glGetUniformLocation(program_,"coefficient_stride"),x_stride_,y_stride_);
    glUniform1i(glGetUniformLocation(program_,"axis"),0);
    glDispatchCompute(28,GLuint((height+7)/8),1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
    glUniform1i(glGetUniformLocation(program_,"axis"),1);
    glDispatchCompute(28,28,1);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);Check();
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[3]);
    const void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
    if(!data)throw std::runtime_error("LocateAnything GPU output mapping failed");
    std::vector<float> output(3U*448*224);std::memcpy(output.data(),data,bytes);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("LocateAnything GPU output invalidated");
    Check();return output;
  }

  std::vector<float> RunNv12(const std::vector<uint8_t>& nv12,int width,int height,bool bt709,bool full_range) {
    if(owner_!=std::this_thread::get_id())throw std::logic_error("LocateAnything GPU thread mismatch");
    if(width<1 || height<1 || width>8192 || height>8192 || width%2 || height%2 || nv12.size()!=size_t(width)*height*3/2)
      throw std::invalid_argument("LocateAnything NV12 dimensions/storage invalid");
    // Keep the established hardware color conversion at source resolution.
    // Resizing is performed only by the independent Pillow-compatible pass.
    if(!color_)color_=std::make_unique<GlesPreprocessor>();
    ImageTransform t;t.width=width;t.height=height;t.letterbox=false;t.nearest=true;
    t.yuv_bt709=bt709;t.yuv_full_range=full_range;
    return RunRgba(color_->RunNv12Rgba(nv12,width,height,t),width,height);
  }

 private:
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
      if(total==0)throw std::runtime_error("LocateAnything empty resize filter");
      for(int k=0;k<count;++k){
        const double scaled=weights[k]/total*4194304.0;
        t.data[size_t(output)*2+size_t(i)*t.stride+k]=int32_t(scaled+(scaled<0?-0.5:0.5));
      }
    }
    return t;
  }
  void Activate(){
    if(!eglBindAPI(EGL_OPENGL_ES_API)||!eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context))
      throw std::runtime_error("Cannot activate LocateAnything Mali preprocessing");
  }
  void Close(){
    if(context_.context!=EGL_NO_CONTEXT){
      if(eglBindAPI(EGL_OPENGL_ES_API)&&eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context)){
        glDeleteBuffers(5,buffers_);if(texture_)glDeleteTextures(1,&texture_);if(program_)glDeleteProgram(program_);
      }
    }
    hw_gl_close(&context_);
  }
  void Upload(int index,const void* data,size_t bytes,GLenum usage){
    GLint64 limit=0;glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE,&limit);
    if(bytes>size_t(limit))throw std::invalid_argument("LocateAnything GPU buffer exceeds hardware limit");
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[index]);glBufferData(GL_SHADER_STORAGE_BUFFER,GLsizeiptr(bytes),data,usage);
  }
  static void Check(){const auto e=glGetError();if(e!=GL_NO_ERROR)throw std::runtime_error("LocateAnything GLES error "+std::to_string(e));}
  // Exact original to_tensor+normalize FP32 outputs for RGB8 levels0..255.
  // Provenance: locateanything-original-normalization-lut-v1.json, SHA256
  // b3afd7e8dda89016d402ff208d0206fd9c7d564c41ecd4152ff1626082b7b1ff.
  // The table is indexed on Mali;CPU never normalizes or filters input pixels.
  static const uint32_t* NormalizationBits(){
    static constexpr uint32_t bits[256]={
      0xbf800000u, 0xbf7dfdfeu, 0xbf7bfbfcu, 0xbf79f9fau, 0xbf77f7f8u, 0xbf75f5f6u, 0xbf73f3f4u, 0xbf71f1f2u,
      0xbf6feff0u, 0xbf6dedeeu, 0xbf6bebecu, 0xbf69e9eau, 0xbf67e7e8u, 0xbf65e5e6u, 0xbf63e3e4u, 0xbf61e1e2u,
      0xbf5fdfe0u, 0xbf5ddddeu, 0xbf5bdbdcu, 0xbf59d9dau, 0xbf57d7d8u, 0xbf55d5d6u, 0xbf53d3d4u, 0xbf51d1d2u,
      0xbf4fcfd0u, 0xbf4dcdceu, 0xbf4bcbccu, 0xbf49c9cau, 0xbf47c7c8u, 0xbf45c5c6u, 0xbf43c3c4u, 0xbf41c1c2u,
      0xbf3fbfc0u, 0xbf3dbdbeu, 0xbf3bbbbcu, 0xbf39b9bau, 0xbf37b7b8u, 0xbf35b5b6u, 0xbf33b3b4u, 0xbf31b1b2u,
      0xbf2fafb0u, 0xbf2dadaeu, 0xbf2babacu, 0xbf29a9aau, 0xbf27a7a8u, 0xbf25a5a6u, 0xbf23a3a4u, 0xbf21a1a2u,
      0xbf1f9fa0u, 0xbf1d9d9eu, 0xbf1b9b9cu, 0xbf19999au, 0xbf179798u, 0xbf159596u, 0xbf139394u, 0xbf119192u,
      0xbf0f8f90u, 0xbf0d8d8eu, 0xbf0b8b8cu, 0xbf09898au, 0xbf078788u, 0xbf058586u, 0xbf038384u, 0xbf018182u,
      0xbefefefeu, 0xbefafafau, 0xbef6f6f6u, 0xbef2f2f2u, 0xbeeeeeeeu, 0xbeeaeaeau, 0xbee6e6e6u, 0xbee2e2e2u,
      0xbedededeu, 0xbedadadau, 0xbed6d6d6u, 0xbed2d2d2u, 0xbecececeu, 0xbecacacau, 0xbec6c6c6u, 0xbec2c2c2u,
      0xbebebebeu, 0xbebababau, 0xbeb6b6b6u, 0xbeb2b2b2u, 0xbeaeaeaeu, 0xbeaaaaaau, 0xbea6a6a6u, 0xbea2a2a2u,
      0xbe9e9e9eu, 0xbe9a9a9au, 0xbe969696u, 0xbe929292u, 0xbe8e8e8eu, 0xbe8a8a8au, 0xbe868686u, 0xbe828282u,
      0xbe7cfcfcu, 0xbe74f4f4u, 0xbe6cececu, 0xbe64e4e4u, 0xbe5cdcdcu, 0xbe54d4d4u, 0xbe4cccccu, 0xbe44c4c4u,
      0xbe3cbcbcu, 0xbe34b4b4u, 0xbe2cacacu, 0xbe24a4a4u, 0xbe1c9c9cu, 0xbe149494u, 0xbe0c8c8cu, 0xbe048484u,
      0xbdf8f8f8u, 0xbde8e8e8u, 0xbdd8d8d8u, 0xbdc8c8c8u, 0xbdb8b8b8u, 0xbda8a8a8u, 0xbd989898u, 0xbd888888u,
      0xbd70f0f0u, 0xbd50d0d0u, 0xbd30b0b0u, 0xbd109090u, 0xbce0e0e0u, 0xbca0a0a0u, 0xbc40c0c0u, 0xbb808080u,
      0x3b808100u, 0x3c40c100u, 0x3ca0a0c0u, 0x3ce0e100u, 0x3d1090a0u, 0x3d30b0c0u, 0x3d50d0e0u, 0x3d70f100u,
      0x3d888890u, 0x3d9898a0u, 0x3da8a8b0u, 0x3db8b8c0u, 0x3dc8c8d0u, 0x3dd8d8e0u, 0x3de8e8f0u, 0x3df8f900u,
      0x3e048488u, 0x3e0c8c90u, 0x3e149498u, 0x3e1c9ca0u, 0x3e24a4a8u, 0x3e2cacb0u, 0x3e34b4b8u, 0x3e3cbcc0u,
      0x3e44c4c8u, 0x3e4cccd0u, 0x3e54d4d8u, 0x3e5cdce0u, 0x3e64e4e8u, 0x3e6cecf0u, 0x3e74f4f8u, 0x3e7cfd00u,
      0x3e828284u, 0x3e868688u, 0x3e8a8a8cu, 0x3e8e8e90u, 0x3e929294u, 0x3e969698u, 0x3e9a9a9cu, 0x3e9e9ea0u,
      0x3ea2a2a4u, 0x3ea6a6a8u, 0x3eaaaaacu, 0x3eaeaeb0u, 0x3eb2b2b4u, 0x3eb6b6b8u, 0x3ebababcu, 0x3ebebec0u,
      0x3ec2c2c4u, 0x3ec6c6c8u, 0x3ecacaccu, 0x3ececed0u, 0x3ed2d2d4u, 0x3ed6d6d8u, 0x3edadadcu, 0x3ededee0u,
      0x3ee2e2e4u, 0x3ee6e6e8u, 0x3eeaeaecu, 0x3eeeeef0u, 0x3ef2f2f4u, 0x3ef6f6f8u, 0x3efafafcu, 0x3efeff00u,
      0x3f018182u, 0x3f038384u, 0x3f058586u, 0x3f078788u, 0x3f09898au, 0x3f0b8b8cu, 0x3f0d8d8eu, 0x3f0f8f90u,
      0x3f119192u, 0x3f139394u, 0x3f159596u, 0x3f179798u, 0x3f19999au, 0x3f1b9b9cu, 0x3f1d9d9eu, 0x3f1f9fa0u,
      0x3f21a1a2u, 0x3f23a3a4u, 0x3f25a5a6u, 0x3f27a7a8u, 0x3f29a9aau, 0x3f2babacu, 0x3f2dadaeu, 0x3f2fafb0u,
      0x3f31b1b2u, 0x3f33b3b4u, 0x3f35b5b6u, 0x3f37b7b8u, 0x3f39b9bau, 0x3f3bbbbcu, 0x3f3dbdbeu, 0x3f3fbfc0u,
      0x3f41c1c2u, 0x3f43c3c4u, 0x3f45c5c6u, 0x3f47c7c8u, 0x3f49c9cau, 0x3f4bcbccu, 0x3f4dcdceu, 0x3f4fcfd0u,
      0x3f51d1d2u, 0x3f53d3d4u, 0x3f55d5d6u, 0x3f57d7d8u, 0x3f59d9dau, 0x3f5bdbdcu, 0x3f5ddddeu, 0x3f5fdfe0u,
      0x3f61e1e2u, 0x3f63e3e4u, 0x3f65e5e6u, 0x3f67e7e8u, 0x3f69e9eau, 0x3f6bebecu, 0x3f6dedeeu, 0x3f6feff0u,
      0x3f71f1f2u, 0x3f73f3f4u, 0x3f75f5f6u, 0x3f77f7f8u, 0x3f79f9fau, 0x3f7bfbfcu, 0x3f7dfdfeu, 0x3f800000u,
    };
    return bits;
  }
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
  if(p.x>=448 || p.y>=(axis==0?source_size.y:224))return;
  ivec3 sum=ivec3(2097152);
  if(axis==0){
    int first=cx[2*p.x],count=cx[2*p.x+1],offset=896+p.x*coefficient_stride.x;
    for(int k=0;k<count;++k)sum+=ivec3(texelFetch(source_image,ivec2(first+k,p.y),0).rgb)*cx[offset+k];
    uvec3 v=uvec3(clamp(sum>>22,ivec3(0),ivec3(255)));
    pixels[p.y*448+p.x]=v.x|(v.y<<8)|(v.z<<16);
  }else{
    int first=cy[2*p.y],count=cy[2*p.y+1],offset=448+p.y*coefficient_stride.y;
    for(int k=0;k<count;++k)sum+=ivec3(rgb(pixels[(first+k)*448+p.x]))*cy[offset+k];
    ivec3 v=clamp(sum>>22,ivec3(0),ivec3(255));
    vec3 normalized=vec3(uintBitsToFloat(normalization_bits[v.r]),
                         uintBitsToFloat(normalization_bits[v.g]),
                         uintBitsToFloat(normalization_bits[v.b]));
    int i=p.y*448+p.x;
    values[i]=normalized.r;values[100352+i]=normalized.g;values[200704+i]=normalized.b;
  }
})GLSL";}
  hw_gl context_{};
  GLuint program_=0,texture_=0,buffers_[5]{};
  int width_=0,height_=0,x_stride_=0,y_stride_=0;
  const std::thread::id owner_=std::this_thread::get_id();
  std::unique_ptr<GlesPreprocessor> color_;
};
}

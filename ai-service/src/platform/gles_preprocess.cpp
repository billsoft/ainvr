#include "gles_preprocess.hpp"
#include "gles_context.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <thread>

namespace ainvr {
namespace {
const char* shader = R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16, local_size_y=16) in;
layout(binding=0) uniform highp sampler2D source_image;
layout(binding=2) uniform highp sampler2D chroma_image;
layout(std430,binding=1) buffer Output { float values[]; };
layout(std430,binding=3) buffer JpegOutput { uint packed[]; };
uniform int jpeg_output;
uniform int rgba_output;
uniform ivec2 output_size;
uniform vec4 rectangle;
uniform vec4 source_region;
uniform int crop_region;
uniform int crop_padding;
uniform vec3 mean_value, divisor, padding;
uniform int reverse_channels, perspective;
uniform int input_nv12;
uniform int input_bgr;
uniform int interpolation;
uniform vec3 yuv_offset, yuv_scale, yuv_red, yuv_green, yuv_blue;
uniform vec3 view_angles;
const float PI=3.141592653589793;
vec3 sample_rgb(vec2 uv){
  if(input_nv12==0){
    vec3 color=textureLod(source_image,uv,0.0).rgb*255.0;
    return input_bgr!=0?color.bgr:color;
  }
  vec3 yuv=vec3(textureLod(source_image,uv,0.0).r,textureLod(chroma_image,uv,0.0).rg);
  yuv=(yuv*255.0-yuv_offset)*yuv_scale;
  return clamp(vec3(dot(yuv,yuv_red),dot(yuv,yuv_green),dot(yuv,yuv_blue)),0.0,255.0);
}
vec3 pixel_rgb(ivec2 p){
  vec2 size=vec2(textureSize(source_image,0));
  return floor(sample_rgb((vec2(p)+0.5)/size)+0.5);
}
float cubic_weight(float v){
  float x=abs(v),a=-0.75;
  if(x<1.0)return ((a+2.0)*x-(a+3.0))*x*x+1.0;
  if(x<2.0)return ((a*x-5.0*a)*x+8.0*a)*x-4.0*a;
  return 0.0;
}
float lanczos_weight(float v){
  float x=abs(v);
  if(x<0.000001)return 1.0;
  if(x>=4.0)return 0.0;
  float z=PI*x;
  return sin(z)*sin(z/4.0)/(z*z/4.0);
}
vec3 sample_filtered(vec2 uv){
  if(interpolation==0)return sample_rgb(uv);
  vec2 pos=uv*vec2(textureSize(source_image,0))-0.5;
  ivec2 origin=ivec2(floor(pos));
  vec2 f=pos-vec2(origin);
  vec3 rgb=vec3(0);
  if(interpolation==1){
    float wx[4],wy[4];
    for(int k=0;k<4;++k){wx[k]=cubic_weight(f.x-float(k-1));wy[k]=cubic_weight(f.y-float(k-1));}
    for(int y=0;y<4;++y)for(int x=0;x<4;++x)
      rgb+=pixel_rgb(origin+ivec2(x-1,y-1))*wx[x]*wy[y];
  }else{
    float wx[8],wy[8],sx=0.0,sy=0.0;
    for(int k=0;k<8;++k){
      wx[k]=lanczos_weight(f.x-float(k-3));wy[k]=lanczos_weight(f.y-float(k-3));sx+=wx[k];sy+=wy[k];
    }
    for(int y=0;y<8;++y)for(int x=0;x<8;++x)
      rgb+=pixel_rgb(origin+ivec2(x-3,y-3))*wx[x]*wy[y];
    rgb/=sx*sy;
  }
  return floor(clamp(rgb,0.0,255.0)+0.5);
}
vec3 sample_area(ivec2 p){
  vec2 size=vec2(textureSize(source_image,0));
  vec2 region0=crop_region!=0?source_region.xy*size:vec2(0);
  vec2 region_size=crop_region!=0?source_region.zw*size:size;
  vec2 local=vec2(p)-rectangle.xy;
  vec2 lo=region0+local*region_size/rectangle.zw;
  vec2 hi=region0+(local+1.0)*region_size/rectangle.zw;
  ivec2 start=ivec2(floor(lo)),end=ivec2(ceil(hi));
  vec3 rgb=vec3(0);
  for(int y=start.y;y<end.y;++y){
    float wy=max(0.0,min(hi.y,float(y+1))-max(lo.y,float(y)));
    for(int x=start.x;x<end.x;++x){
      float wx=max(0.0,min(hi.x,float(x+1))-max(lo.x,float(x)));
      rgb+=pixel_rgb(ivec2(x,y))*wx*wy;
    }
  }
  rgb/=(hi.x-lo.x)*(hi.y-lo.y);
  return floor(clamp(rgb,0.0,255.0)+0.5);
}
vec3 render_rgb(ivec2 p) {
  vec2 xy=vec2(p)+0.5;
  vec2 uv=(xy-rectangle.xy)/rectangle.zw;
  vec3 rgb=padding;
  if(perspective!=0){
    vec2 q=xy/vec2(output_size)*2.0-1.0;
    float t=tan(view_angles.z*0.5);
    vec3 d=normalize(vec3(q.x*t,-q.y*t*float(output_size.y)/float(output_size.x),1.0));
    float cp=cos(view_angles.y),sp=sin(view_angles.y);
    d=vec3(d.x,cp*d.y+sp*d.z,-sp*d.y+cp*d.z);
    float cy=cos(view_angles.x),sy=sin(view_angles.x);
    d=vec3(cy*d.x+sy*d.z,d.y,-sy*d.x+cy*d.z);
    uv=vec2(atan(d.x,d.z)/(2.0*PI)+0.5,0.5-asin(clamp(d.y,-1.0,1.0))/PI);
    rgb=sample_filtered(uv);
  }else if(all(greaterThanEqual(uv,vec2(0)))&&all(lessThan(uv,vec2(1)))){
    if(crop_region!=0)uv=source_region.xy+uv*source_region.zw;
    if(crop_padding==0||(all(greaterThanEqual(uv,vec2(0)))&&all(lessThan(uv,vec2(1)))))
      rgb=interpolation==2?sample_area(p):sample_filtered(uv);
  }
  return rgb;
}
uint byte_value(float v){return uint(floor(clamp(v,0.0,255.0)+0.5));}
uint pack4(uvec4 v){return v.x|(v.y<<8)|(v.z<<16)|(v.w<<24);}
vec2 chroma(vec3 rgb){return vec2(dot(rgb,vec3(-0.168736,-0.331264,0.5)),dot(rgb,vec3(0.5,-0.418688,-0.081312)))+128.0;}
void main() {
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);
  if(jpeg_output!=0){
    p*=ivec2(4,2);if(any(greaterThanEqual(p,output_size)))return;
    vec3 a[4];vec3 b[4];uvec4 ya,yb;
    for(int x=0;x<4;++x){
      a[x]=render_rgb(min(p+ivec2(x,0),output_size-1));
      b[x]=render_rgb(min(p+ivec2(x,1),output_size-1));
      ya[x]=byte_value(dot(a[x],vec3(0.299,0.587,0.114)));
      yb[x]=byte_value(dot(b[x],vec3(0.299,0.587,0.114)));
    }
    int stride=(output_size.x+3)/4;
    packed[p.y*stride+p.x/4]=pack4(ya);
    packed[(p.y+1)*stride+p.x/4]=pack4(yb);
    vec2 uv0=chroma((a[0]+a[1]+b[0]+b[1])*0.25);
    vec2 uv1=chroma((a[2]+a[3]+b[2]+b[3])*0.25);
    packed[output_size.y*stride+(p.y/2)*stride+p.x/4]=pack4(uvec4(byte_value(uv0.x),byte_value(uv0.y),byte_value(uv1.x),byte_value(uv1.y)));
    return;
  }
  if(any(greaterThanEqual(p,output_size)))return;
  vec3 rgb=render_rgb(p);
  if(rgba_output!=0){
    packed[p.y*output_size.x+p.x]=pack4(uvec4(byte_value(rgb.r),byte_value(rgb.g),byte_value(rgb.b),255u));
    return;
  }
  if(reverse_channels!=0)rgb=rgb.bgr;
  rgb=(rgb-mean_value)/divisor;
  int i=p.y*output_size.x+p.x; int area=output_size.x*output_size.y;
  values[i]=rgb.r;values[area+i]=rgb.g;values[2*area+i]=rgb.b;
})GLSL";
void CheckGL() { GLenum e=glGetError(); if(e!=GL_NO_ERROR)throw std::runtime_error("GLES error "+std::to_string(e)); }
// Each image backend can coexist with BPU preprocessing and archive contexts
// on the inference thread. Always restore the caller's binding and selected API.
struct EglBinding {
  EGLDisplay display=eglGetCurrentDisplay();EGLContext context=eglGetCurrentContext();
  EGLSurface draw=eglGetCurrentSurface(EGL_DRAW),read=eglGetCurrentSurface(EGL_READ);
  EGLenum api=eglQueryAPI();
  ~EglBinding(){
    if(display!=EGL_NO_DISPLAY)eglMakeCurrent(display,draw,read,context);
    else if(auto current=eglGetCurrentDisplay();current!=EGL_NO_DISPLAY)
      eglMakeCurrent(current,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
    eglBindAPI(api);
  }
};
}
struct GlesPreprocessor::State {
  hw_gl context{}; GLuint program=0, texture=0, chroma=0, buffer=0;
  uint64_t cached_source_tag=0; int cached_width=0,cached_height=0;
  std::thread::id owner=std::this_thread::get_id();
  ~State(){
    EglBinding saved;
    if(saved.context==context.context){saved.display=EGL_NO_DISPLAY;saved.context=EGL_NO_CONTEXT;}
    if(context.context!=EGL_NO_CONTEXT){
      if(eglBindAPI(EGL_OPENGL_ES_API)&&eglMakeCurrent(context.display,context.surface,context.surface,context.context)){
        if(buffer)glDeleteBuffers(1,&buffer);if(texture)glDeleteTextures(1,&texture);if(chroma)glDeleteTextures(1,&chroma);if(program)glDeleteProgram(program);
      }
    }
    hw_gl_close(&context);
  }
};
GlesPreprocessor::GlesPreprocessor():state_(std::make_unique<State>()) {
  EglBinding saved;
  auto& s=*state_; if(hw_gl_open(&s.context))throw std::runtime_error("Mali GLES context unavailable");
  GLuint compute=glCreateShader(GL_COMPUTE_SHADER);
  glShaderSource(compute,1,&shader,nullptr);glCompileShader(compute);
  GLint ok=0;glGetShaderiv(compute,GL_COMPILE_STATUS,&ok);
  if(!ok){char log[4096]{};glGetShaderInfoLog(compute,sizeof(log),nullptr,log);glDeleteShader(compute);throw std::runtime_error(log);}
  s.program=glCreateProgram();glAttachShader(s.program,compute);glLinkProgram(s.program);glDeleteShader(compute);
  glGetProgramiv(s.program,GL_LINK_STATUS,&ok);
  if(!ok){char log[4096]{};glGetProgramInfoLog(s.program,sizeof(log),nullptr,log);throw std::runtime_error(log);}
  glGenTextures(1,&s.texture);glGenTextures(1,&s.chroma);glGenBuffers(1,&s.buffer);CheckGL();
}
GlesPreprocessor::~GlesPreprocessor()=default;
void ValidateSourceRegion(const ImageTransform& t) {
  if(!t.source_region)return;
  const auto& r=*t.source_region;
  if(t.erp_perspective||t.letterbox||r[2]<=0||r[3]<=0||
     !std::all_of(r.begin(),r.end(),[](float x){return std::isfinite(x)&&std::abs(x)<=131072;}))
    throw std::invalid_argument("Invalid source region or conflicting transform");
}
void ValidateInterpolation(const ImageTransform& t,int w,int h){
  const int mode=static_cast<int>(t.interpolation);
  if(mode<0||mode>3||(t.nearest&&mode!=0))throw std::invalid_argument("Invalid or conflicting interpolation mode");
  if(t.interpolation!=ImageInterpolation::Area)return;
  if(t.erp_perspective)throw std::invalid_argument("Area footprint for ERP projection is not defined");
  double nw=t.width,nh=t.height;
  if(t.letterbox){double ratio=std::min(nw/w,nh/h);nw=std::nearbyint(w*ratio);nh=std::nearbyint(h*ratio);}
  const double sw=t.source_region?(*t.source_region)[2]:w;
  const double sh=t.source_region?(*t.source_region)[3]:h;
  if(nw<=0||nh<=0||(std::ceil(sw/nw)+1)*(std::ceil(sh/nh)+1)>4096)
    throw std::invalid_argument("Area resize footprint exceeds the bounded 4096-tap GPU contract");
}
std::vector<float> GlesPreprocessor::Run(const std::vector<uint8_t>& rgba,int w,int h,const ImageTransform& t) {
  return RunImpl(rgba,w,h,t,false);
}
std::vector<float> GlesPreprocessor::RunNv12(const std::vector<uint8_t>& nv12,int w,int h,const ImageTransform& t) {
  return RunImpl(nv12,w,h,t,true);
}
std::vector<uint8_t> GlesPreprocessor::RunNv12Rgba(const std::vector<uint8_t>& pixels,int w,int h,const ImageTransform& transform,uint64_t immutable_source_tag){
  auto t=transform;t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  std::vector<uint8_t> rgba;RunImpl(pixels,w,h,t,true,nullptr,false,&rgba,immutable_source_tag);return rgba;
}
std::vector<uint8_t> GlesPreprocessor::RunJpegNv12(const std::vector<uint8_t>& pixels,int w,int h,const ImageTransform& transform){
  if(transform.width%2||transform.height%2)throw std::invalid_argument("JPEG NV12 needs even dimensions");
  auto t=transform;t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  std::vector<uint8_t> jpeg;RunImpl(pixels,w,h,t,true,&jpeg);return jpeg;
}
std::vector<uint8_t> GlesPreprocessor::RunBgrJpegNv12(const std::vector<uint8_t>& pixels,int w,int h,const ImageTransform& transform){
  if(transform.width%2||transform.height%2)throw std::invalid_argument("JPEG NV12 needs even dimensions");
  auto t=transform;t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  std::vector<uint8_t> jpeg;RunImpl(pixels,w,h,t,false,&jpeg,true);return jpeg;
}
std::vector<uint8_t> GlesPreprocessor::RunRgbaJpegNv12(const std::vector<uint8_t>& pixels,int w,int h,const ImageTransform& transform){
  if(transform.width%2||transform.height%2)throw std::invalid_argument("JPEG NV12 needs even dimensions");
  auto t=transform;t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  std::vector<uint8_t> jpeg;RunImpl(pixels,w,h,t,false,&jpeg);return jpeg;
}
std::vector<float> GlesPreprocessor::RunImpl(const std::vector<uint8_t>& rgba,int w,int h,const ImageTransform& t,bool nv12,std::vector<uint8_t>* jpeg,bool bgr_input,std::vector<uint8_t>* rgba_output,uint64_t immutable_source_tag) {
  auto& s=*state_;
  const bool cached=nv12 && immutable_source_tag && s.cached_source_tag==immutable_source_tag && s.cached_width==w && s.cached_height==h;
  s.cached_source_tag=0; // Any failure or untagged call invalidates reuse.
  ValidateSourceRegion(t);
  if(s.owner!=std::this_thread::get_id())throw std::runtime_error("GLES context thread mismatch");
  EglBinding saved;
  if(!eglBindAPI(EGL_OPENGL_ES_API)||!eglMakeCurrent(s.context.display,s.context.surface,s.context.surface,s.context.context))
    throw std::runtime_error("Cannot activate Mali preprocessing context");
  if(w<=0||h<=0||t.width<=0||t.height<=0||(nv12&&(w%2||h%2))||rgba.size()!=(nv12?size_t(w)*size_t(h)*3/2:size_t(w)*size_t(h)*(bgr_input?3:4)))throw std::invalid_argument("invalid image dimensions/storage");
  ValidateInterpolation(t,w,h);
  GLint limit=0;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);
  if(w>limit||h>limit||t.width>limit||t.height>limit)throw std::invalid_argument("image exceeds GPU texture limit");
  for(int i=0;i<3;++i)if(!std::isfinite(t.mean[i])||!std::isfinite(t.divisor[i])||t.divisor[i]==0||!std::isfinite(t.padding[i]))throw std::invalid_argument("invalid normalization");
  if(t.erp_perspective&&(!std::isfinite(t.yaw)||!std::isfinite(t.pitch)||!(t.horizontal_fov>0&&t.horizontal_fov<3.14159265f)))throw std::invalid_argument("invalid ERP projection");
  size_t count=size_t(t.width)*t.height*3;
  size_t stride=(size_t(t.width)+3)/4*4;
  size_t bytes=rgba_output?size_t(t.width)*t.height*4:jpeg?stride*t.height*3/2:count*sizeof(float);
  GLint64 max_buffer=0;glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE,&max_buffer);
  if(bytes>size_t(max_buffer))throw std::invalid_argument("output exceeds GPU storage buffer limit");
  glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,s.texture);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,t.nearest?GL_NEAREST:GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,t.nearest?GL_NEAREST:GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,t.erp_perspective?GL_REPEAT:GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
  glPixelStorei(GL_UNPACK_ALIGNMENT,1);
  if(!cached)glTexImage2D(GL_TEXTURE_2D,0,nv12?GL_R8:(bgr_input?GL_RGB8:GL_RGBA8),w,h,0,nv12?GL_RED:(bgr_input?GL_RGB:GL_RGBA),GL_UNSIGNED_BYTE,rgba.data());
  glActiveTexture(GL_TEXTURE2);glBindTexture(GL_TEXTURE_2D,s.chroma);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,t.nearest?GL_NEAREST:GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,t.nearest?GL_NEAREST:GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,t.erp_perspective?GL_REPEAT:GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
  const uint8_t neutral[]={128,128};
  if(!cached)glTexImage2D(GL_TEXTURE_2D,0,GL_RG8,nv12?w/2:1,nv12?h/2:1,0,GL_RG,GL_UNSIGNED_BYTE,nv12?rgba.data()+size_t(w)*h:neutral);
  glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.buffer);glBufferData(GL_SHADER_STORAGE_BUFFER,bytes,nullptr,GL_STREAM_READ);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER,3,s.buffer);
  glBindBufferBase(GL_SHADER_STORAGE_BUFFER,1,s.buffer);glUseProgram(s.program);
  auto uniform=[&](const char* n){return glGetUniformLocation(s.program,n);};
  glUniform1i(uniform("jpeg_output"),jpeg!=nullptr);
  glUniform1i(uniform("rgba_output"),rgba_output!=nullptr);
  glUniform1i(uniform("input_nv12"),nv12);
  glUniform1i(uniform("input_bgr"),bgr_input);
  glUniform1i(uniform("interpolation"),static_cast<int>(t.interpolation));
  glUniform3f(uniform("yuv_offset"),t.yuv_full_range?0:16,128,128);
  glUniform3f(uniform("yuv_scale"),t.yuv_full_range?1:255.f/219,t.yuv_full_range?1:255.f/224,t.yuv_full_range?1:255.f/224);
  glUniform3f(uniform("yuv_red"),1,0,t.yuv_bt709?1.5748f:1.402f);
  glUniform3f(uniform("yuv_green"),1,t.yuv_bt709?-0.187324f:-0.344136f,t.yuv_bt709?-0.468124f:-0.714136f);
  glUniform3f(uniform("yuv_blue"),1,t.yuv_bt709?1.8556f:1.772f,0);
  glUniform2i(uniform("output_size"),t.width,t.height);
  glUniform1i(uniform("crop_region"),t.source_region.has_value());
  glUniform1i(uniform("crop_padding"),t.source_region_padding);
  if(t.source_region){const auto& r=*t.source_region;
    glUniform4f(uniform("source_region"),r[0]/w,r[1]/h,r[2]/w,r[3]/h);}
  int nw=t.width,nh=t.height;
  if(t.letterbox&&!t.erp_perspective){double scale=std::min(double(t.width)/w,double(t.height)/h);nw=int(std::nearbyint(w*scale));nh=int(std::nearbyint(h*scale));if(nw<1||nh<1)throw std::invalid_argument("letterbox dimension rounds to zero");}
  glUniform4f(uniform("rectangle"),(t.width-nw)/2,(t.height-nh)/2,nw,nh);
  glUniform3fv(uniform("mean_value"),1,t.mean.data());glUniform3fv(uniform("divisor"),1,t.divisor.data());glUniform3fv(uniform("padding"),1,t.padding.data());
  glUniform1i(uniform("reverse_channels"),t.bgr);glUniform1i(uniform("perspective"),t.erp_perspective);
  glUniform3f(uniform("view_angles"),t.yaw,t.pitch,t.horizontal_fov);
  glDispatchCompute(jpeg?(t.width+63)/64:(t.width+15)/16,jpeg?(t.height+31)/32:(t.height+15)/16,1);
  glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);CheckGL();
  const void* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
  if(!data)throw std::runtime_error("GPU output mapping failed");
  std::vector<float> result;
  if(rgba_output){rgba_output->resize(bytes);std::memcpy(rgba_output->data(),data,bytes);}
  else if(jpeg){
    jpeg->resize(size_t(t.width)*t.height*3/2);
    for(int y=0;y<t.height*3/2;++y)std::memcpy(jpeg->data()+size_t(y)*t.width,static_cast<const uint8_t*>(data)+size_t(y)*stride,t.width);
  }else{result.resize(count);std::memcpy(result.data(),data,bytes);}
  if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("GPU output invalidated");CheckGL();
  s.cached_source_tag=nv12?immutable_source_tag:0;s.cached_width=w;s.cached_height=h;
  return result;
}
}

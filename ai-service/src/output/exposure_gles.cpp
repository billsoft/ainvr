// Copyright AINVR. Hardware execution of the original local-exposure algorithm.
#include "exposure.hpp"
#include "exposure_backend.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <stdexcept>
#ifdef AINVR_EXPOSURE_GLES
#include "platform/gles_context.h"
#endif

namespace ai_service::output {
namespace {
std::atomic<uint64_t> gpu_runs{0}, failures{0};
void Validate(const cv::Mat& image, int channels, double target, double strength,
              double max_stops, double scale, double sigma, double dead_zone) {
  if (image.empty() || image.type() != CV_MAKETYPE(CV_8U, channels))
    throw std::invalid_argument("Exposure requires nonempty uint8 BGR or RGBA");
  for (double v : {target, strength, max_stops, scale, sigma, dead_zone})
    if (!std::isfinite(v)) throw std::invalid_argument("Nonfinite exposure parameter");
  if (target < 0 || target > 255 || strength < 0 || strength > 1 ||
      max_stops < 0 || max_stops > 4 || scale <= 0 || scale > .5 ||
      sigma <= 0 || sigma > 8 || dead_zone < 0 || dead_zone > 4)
    throw std::invalid_argument("Exposure parameter outside supported range");
  if (image.cols > 4096 || image.rows > 4096 || image.total() > 4u * 1024 * 1024)
    throw std::invalid_argument("Exposure crop exceeds GPU memory budget");
}
#ifdef AINVR_EXPOSURE_GLES
// No intermediate pixels are read back. Only the final packed image crosses
// back to the existing archive job. CPU work is uniforms, LUTs and byte copies.
const char* compute_shader = R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=16) in;
layout(binding=0) uniform highp sampler2D input_image;
layout(binding=1) uniform highp sampler2D decode_lut;
layout(binding=2) uniform highp sampler2D encode_lut;
layout(std430,binding=0) readonly buffer ReadA { vec4 a[]; };
layout(std430,binding=1) readonly buffer ReadB { vec4 b[]; };
layout(std430,binding=2) buffer WriteC { vec4 c[]; };
layout(std430,binding=3) buffer Output { uint pixels[]; };
layout(std430,binding=4) buffer Bounds { uint low; uint high; };
uniform ivec2 input_size, output_size;
uniform int operation, radius, rgba_input;
uniform float sigma_space, sigma_color, target_log, strength, max_stops, dead_zone;
int idx(ivec2 p,ivec2 size){return p.y*size.x+p.x;}
int reflect101(int x,int n){
  if(n<=1)return 0;
  int period=2*(n-1);x=x%period;if(x<0)x+=period;
  return x<n?x:period-x;
}
ivec2 reflected(ivec2 p,ivec2 size){return ivec2(reflect101(p.x,size.x),reflect101(p.y,size.y));}
float linear_channel(float x){return texelFetch(decode_lut,ivec2(int(roundEven(x*255.0)),0),0).r;}
uint encoded(float x){
  int i=int(clamp(roundEven(x*65535.0),0.0,65535.0));
  return uint(roundEven(texelFetch(encode_lut,ivec2(i%256,i/256),0).r*255.0));
}
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);if(any(greaterThanEqual(p,output_size)))return;
  int i=idx(p,output_size);
  if(operation==0){
    vec3 src=texelFetch(input_image,p,0).rgb;
    vec3 rgb=vec3(linear_channel(src.x),linear_channel(src.y),linear_channel(src.z));
    float y=dot(rgb,rgba_input!=0?vec3(.2126,.7152,.0722):vec3(.0722,.7152,.2126));
    float l=log2(max(y,1e-6));c[i]=vec4(rgb,l);
    atomicMin(low,floatBitsToUint(l+20.0));atomicMax(high,floatBitsToUint(l+20.0));
  }else if(operation==1){
    // INTER_AREA: integrate source pixel cells, including fractional borders.
    vec2 ratio=vec2(input_size)/vec2(output_size);
    vec2 begin=vec2(p)*ratio,end=vec2(p+1)*ratio;
    float sum=0.0;
    for(int y=int(floor(begin.y));y<int(ceil(end.y));++y)
      for(int x=int(floor(begin.x));x<int(ceil(end.x));++x){
        float weight=max(0.0,min(end.x,float(x+1))-max(begin.x,float(x))) *
                     max(0.0,min(end.y,float(y+1))-max(begin.y,float(y)));
        sum+=a[idx(clamp(ivec2(x,y),ivec2(0),input_size-1),input_size)].w*weight;
      }
    c[i]=vec4(sum/(ratio.x*ratio.y),0,0,0);
  }else if(operation==2){
    float center=a[i].x,sum=0.0,weights=0.0;
    // OpenCV's float bilateral kernel includes the circular spatial support.
    for(int y=-radius;y<=radius;++y)for(int x=-radius;x<=radius;++x){
      int dist=x*x+y*y;if(dist>radius*radius)continue;
      float value=a[idx(reflected(p+ivec2(x,y),input_size),input_size)].x;
      float diff=value-center;
      float weight=exp(-.5*(float(dist)/(sigma_space*sigma_space)+diff*diff/(sigma_color*sigma_color)));
      sum+=value*weight;weights+=weight;
    }
    c[i]=vec4(sum/weights,0,0,0);
  }else if(operation==3){
    vec2 at=(vec2(p)+.5)*vec2(input_size)/vec2(output_size)-.5;
    ivec2 q=ivec2(floor(at));vec2 f=at-vec2(q);
    float v00=a[idx(clamp(q,ivec2(0),input_size-1),input_size)].x;
    float v10=a[idx(clamp(q+ivec2(1,0),ivec2(0),input_size-1),input_size)].x;
    float v01=a[idx(clamp(q+ivec2(0,1),ivec2(0),input_size-1),input_size)].x;
    float v11=a[idx(clamp(q+ivec2(1,1),ivec2(0),input_size-1),input_size)].x;
    c[i]=vec4(mix(mix(v00,v10,f.x),mix(v01,v11,f.x),f.y),0,0,0);
  }else if(operation==4){
    vec4 sum=vec4(0);
    for(int x=-radius;x<=radius;++x){
      int j=idx(reflected(p+ivec2(x,0),input_size),input_size);
      float guide=a[j].w,source=b[j].x;
      sum+=vec4(guide,source,guide*guide,guide*source);
    }
    c[i]=sum/float(2*radius+1);
  }else if(operation==5){
    vec4 sum=vec4(0);
    for(int y=-radius;y<=radius;++y)sum+=a[idx(reflected(p+ivec2(0,y),input_size),input_size)];
    vec4 mean=sum/float(2*radius+1);
    float variance=max(mean.z-mean.x*mean.x,0.0);
    float coef=(mean.w-mean.x*mean.y)/(variance+.04);
    c[i]=vec4(coef,mean.y-coef*mean.x,0,0);
  }else if(operation==6){
    vec2 sum=vec2(0);
    for(int x=-radius;x<=radius;++x)sum+=a[idx(reflected(p+ivec2(x,0),input_size),input_size)].xy;
    c[i]=vec4(sum/float(2*radius+1),0,0);
  }else if(operation==7){
    vec2 sum=vec2(0);
    for(int y=-radius;y<=radius;++y)sum+=a[idx(reflected(p+ivec2(0,y),input_size),input_size)].xy;
    vec2 mean=sum/float(2*radius+1);
    float base=mean.x*b[i].w+mean.y;
    c[i]=vec4(clamp(base,uintBitsToFloat(low)-20.0,uintBitsToFloat(high)-20.0),0,0,0);
  }else if(operation==8){
    vec4 decoded=a[i],original=texelFetch(input_image,p,0);
    float base=b[i].x,delta=target_log-base;
    float distance=max(abs(delta)-dead_zone,0.0);
    float darkness=clamp((-3.058894-base)/3.321928,0.0,1.0);
    darkness=darkness*darkness*(3.0-2.0*darkness);
    float cap=min(max_stops,delta>0.0?1.5+1.5*darkness:1.5);
    float stops=sign(delta)*min(distance,cap)*strength;
    float y=dot(decoded.rgb,rgba_input!=0?vec3(.2126,.7152,.0722):vec3(.0722,.7152,.2126));
    if(stops>0.0)stops*=y/(y+.003);
    float pixel_delta=target_log-decoded.w;
    if(stops*pixel_delta>0.0){
      float magnitude=abs(stops),x=abs(pixel_delta)/magnitude;
      // Avoid loss of precision in 1-exp(-x) close to the target.
      float approach=x<.001?x*(1.0-x*.5+x*x/6.0):1.0-exp(-x);
      stops=sign(stops)*.7*magnitude*approach;
    }else stops=0.0;
    float peak=max(max(decoded.x,decoded.y),decoded.z);
    float ceiling=texelFetch(decode_lut,ivec2(254,0),0).r;
    float gain=min(exp2(stops),max(1.0,ceiling/max(peak,1e-8)));
    uvec4 src=uvec4(roundEven(original*255.0)),outp=src;
    if(stops!=0.0)for(int ch=0;ch<3;++ch){
      uint v=encoded(decoded[ch]*gain);
      if(src[ch]>0u&&v==0u)v=1u;if(src[ch]<255u&&v==255u)v=254u;
      outp[ch]=v;
    }
    pixels[i]=outp.x|(outp.y<<8)|(outp.z<<16)|(outp.w<<24);
  }
})GLSL";
void CheckGL() {
  GLenum code=glGetError();
  if(code!=GL_NO_ERROR)throw std::runtime_error("Exposure GLES error "+std::to_string(code));
}
struct CurrentContext {
  EGLDisplay display=eglGetCurrentDisplay();
  EGLContext context=eglGetCurrentContext();
  EGLSurface draw=eglGetCurrentSurface(EGL_DRAW),read=eglGetCurrentSurface(EGL_READ);
  ~CurrentContext(){
    if(display!=EGL_NO_DISPLAY)eglMakeCurrent(display,draw,read,context);
    else {auto current=eglGetCurrentDisplay();if(current!=EGL_NO_DISPLAY)eglMakeCurrent(current,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);}
  }
};
class ExposureGpu {
 public:
  ExposureGpu() {
    CurrentContext saved;
    if(hw_gl_open(&context_)){hw_gl_close(&context_);throw std::runtime_error("Mali exposure context unavailable");}
    try {
      GLuint shader=glCreateShader(GL_COMPUTE_SHADER);
      glShaderSource(shader,1,&compute_shader,nullptr);glCompileShader(shader);
      GLint ok=0;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);
      if(!ok){char log[4096]{};glGetShaderInfoLog(shader,sizeof(log),nullptr,log);glDeleteShader(shader);throw std::runtime_error(log);}
      program_=glCreateProgram();glAttachShader(program_,shader);glLinkProgram(program_);glDeleteShader(shader);
      glGetProgramiv(program_,GL_LINK_STATUS,&ok);
      if(!ok){char log[4096]{};glGetProgramInfoLog(program_,sizeof(log),nullptr,log);throw std::runtime_error(log);}
      glGenBuffers(6,buffers_.data());glGenBuffers(1,&output_);glGenBuffers(1,&bounds_);
      glGenTextures(3,textures_.data());
      std::array<float,256> decode;
      std::array<uint8_t,65536> encode;
      for(int i=0;i<256;++i){float x=float(i)/255;decode[i]=x<=.04045f?x/12.92f:std::pow((x+.055f)/1.055f,2.4f);}
      for(int i=0;i<=65535;++i){float x=float(i)/65535;float s=x<=.0031308f?12.92f*x:1.055f*std::pow(x,1.f/2.4f)-.055f;encode[i]=uint8_t(std::clamp(int(std::nearbyint(s*255)),0,255));}
      Texture(1,GL_R32F,256,1,GL_RED,GL_FLOAT,decode.data());
      Texture(2,GL_R8,256,256,GL_RED,GL_UNSIGNED_BYTE,encode.data());
      CheckGL();
    }catch(...){Destroy();throw;}
  }
  ~ExposureGpu(){
    CurrentContext saved;
    if(!eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context)){
      hw_gl_close(&context_);return;
    }
    Destroy();
  }
  cv::Mat Run(const cv::Mat& image,bool rgba,double target,double strength,
              double max_stops,double scale,double sigma,double dead_zone) {
    CurrentContext saved;MakeCurrent();CheckGL();
    const int w=image.cols,h=image.rows;
    const double radius=std::max(1.,std::min(w,h)*scale),reduction=std::max(1.,radius/8);
    const int sw=std::max(1,int(std::nearbyint(w/reduction))),sh=std::max(1,int(std::nearbyint(h/reduction)));
    const double space=std::max(.5,radius*std::min(double(sw)/w,double(sh)/h));
    const int bilateral_radius=std::max(1,int(std::ceil(2*space)));
    const int guide_radius=std::max(1,int(std::nearbyint(reduction*2)));
    GLint64 limit=0;glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE,&limit);
    const size_t full=size_t(w)*h*16,small=size_t(sw)*sh*16;
    if(std::max(full,small)>size_t(limit))throw std::invalid_argument("Exposure exceeds GPU buffer limit");
    if(area_!=size_t(w)*h||small_area_!=size_t(sw)*sh){
      for(int i=0;i<6;++i){glBindBuffer(GL_SHADER_STORAGE_BUFFER,buffers_[i]);glBufferData(GL_SHADER_STORAGE_BUFFER,(i==1||i==2)?small:full,nullptr,GL_DYNAMIC_DRAW);}
      glBindBuffer(GL_SHADER_STORAGE_BUFFER,output_);glBufferData(GL_SHADER_STORAGE_BUFFER,size_t(w)*h*4,nullptr,GL_DYNAMIC_READ);
      area_=size_t(w)*h;small_area_=size_t(sw)*sh;
    }
    cv::Mat packed=image.isContinuous()?image:image.clone(); // byte copy only
    Texture(0,rgba?GL_RGBA8:GL_RGB8,w,h,rgba?GL_RGBA:GL_RGB,GL_UNSIGNED_BYTE,packed.data);
    for(int unit=1;unit<=2;++unit){glActiveTexture(GL_TEXTURE0+unit);glBindTexture(GL_TEXTURE_2D,textures_[unit]);}
    const uint32_t extremes[2]={0xffffffffu,0};
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,bounds_);glBufferData(GL_SHADER_STORAGE_BUFFER,sizeof(extremes),extremes,GL_DYNAMIC_DRAW);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,3,output_);glBindBufferBase(GL_SHADER_STORAGE_BUFFER,4,bounds_);
    glUseProgram(program_);
    Float("sigma_space",float(space));Float("sigma_color",float(sigma));
    const double lstar=target*100/255,lum=lstar>8?std::pow((lstar+16)/116,3):lstar/(24389./27);
    Float("target_log",float(std::log2(std::max(lum,1e-6))));Float("strength",float(strength));
    Float("max_stops",float(max_stops));Float("dead_zone",float(dead_zone));Int("rgba_input",rgba);
    Dispatch(0,0,0,0,w,h,w,h,0);
    Dispatch(1,0,0,1,w,h,sw,sh,0);
    Dispatch(2,1,1,2,sw,sh,sw,sh,bilateral_radius);
    Dispatch(3,2,2,3,sw,sh,w,h,0);
    Dispatch(4,0,3,4,w,h,w,h,guide_radius);
    Dispatch(5,4,4,5,w,h,w,h,guide_radius);
    Dispatch(6,5,5,4,w,h,w,h,guide_radius);
    Dispatch(7,4,0,3,w,h,w,h,guide_radius);
    Dispatch(8,0,3,5,w,h,w,h,0);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);CheckGL();
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,output_);
    void* mapped=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,size_t(w)*h*4,GL_MAP_READ_BIT);
    if(!mapped)throw std::runtime_error("Exposure GPU readback failed");
    cv::Mat result(h,w,rgba?CV_8UC4:CV_8UC3);
    if(rgba)std::memcpy(result.data,mapped,size_t(w)*h*4);
    else for(size_t i=0;i<size_t(w)*h;++i)std::memcpy(result.data+i*3,static_cast<uint8_t*>(mapped)+i*4,3);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("Exposure GPU readback corrupted");
    CheckGL();++gpu_runs;return result;
  }
 private:
  void MakeCurrent(){if(!eglMakeCurrent(context_.display,context_.surface,context_.surface,context_.context))throw std::runtime_error("Exposure context activation failed");}
  void Destroy(){
    if(context_.context!=EGL_NO_CONTEXT){
      glDeleteBuffers(6,buffers_.data());if(output_)glDeleteBuffers(1,&output_);if(bounds_)glDeleteBuffers(1,&bounds_);
      glDeleteTextures(3,textures_.data());if(program_)glDeleteProgram(program_);
    }
    hw_gl_close(&context_);context_.context=EGL_NO_CONTEXT;context_.display=EGL_NO_DISPLAY;
  }
  void Texture(int unit,GLint internal,int w,int h,GLenum format,GLenum type,const void* data){
    glActiveTexture(GL_TEXTURE0+unit);glBindTexture(GL_TEXTURE_2D,textures_[unit]);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_S,GL_CLAMP_TO_EDGE);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_WRAP_T,GL_CLAMP_TO_EDGE);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);glTexImage2D(GL_TEXTURE_2D,0,internal,w,h,0,format,type,data);
  }
  void Int(const char* name,int value){glUniform1i(glGetUniformLocation(program_,name),value);}
  void Float(const char* name,float value){glUniform1f(glGetUniformLocation(program_,name),value);}
  void Dispatch(int op,int a,int b,int c,int iw,int ih,int ow,int oh,int radius){
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,0,buffers_[a]);glBindBufferBase(GL_SHADER_STORAGE_BUFFER,1,buffers_[b]);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,2,buffers_[c]);Int("operation",op);Int("radius",radius);
    glUniform2i(glGetUniformLocation(program_,"input_size"),iw,ih);glUniform2i(glGetUniformLocation(program_,"output_size"),ow,oh);
    glDispatchCompute((ow+15)/16,(oh+15)/16,1);glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);CheckGL();
  }
  hw_gl context_{};GLuint program_=0,output_=0,bounds_=0;
  std::array<GLuint,6> buffers_{};std::array<GLuint,3> textures_{};
  size_t area_=0,small_area_=0;
};
thread_local std::unique_ptr<ExposureGpu> worker;
#endif
cv::Mat Execute(const cv::Mat& image,bool rgba,double target,double strength,
                double max_stops,double scale,double sigma,double dead_zone) {
#ifdef AINVR_EXPOSURE_GLES
  try {
    if(!worker)worker=std::make_unique<ExposureGpu>();
    return worker->Run(image,rgba,target,strength,max_stops,scale,sigma,dead_zone);
  }catch(...){worker.reset();++failures;throw;}
#else
  ++failures;throw std::runtime_error("Hardware exposure backend unavailable");
#endif
}
}
ExposureBackendStats GetExposureBackendStats(){return {gpu_runs.load(),failures.load(),0};}
cv::Mat CorrectExposure(const cv::Mat& image,double target,double strength,double max_stops,
                         double scale,double sigma,double dead_zone,bool accelerate) {
  Validate(image,3,target,strength,max_stops,scale,sigma,dead_zone);
  if(strength==0||max_stops==0)return image.clone();
  if(!accelerate)throw std::invalid_argument("CPU exposure is a test oracle only");
  return Execute(image,false,target,strength,max_stops,scale,sigma,dead_zone);
}
cv::Mat CorrectExposureRgba(const cv::Mat& image,double target,double strength) {
  Validate(image,4,target,strength,3,.1,.8,.2);
  if(strength==0)return image.clone();
  return Execute(image,true,target,strength,3,.1,.8,.2);
}
}

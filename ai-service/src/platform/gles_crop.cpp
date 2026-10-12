// Copyright AINVR. GPU pixel operations; CPU work is scalar planning and LUTs.
#include "gles_crop.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <cstdlib>
#include <list>
#include <map>
#include <mutex>
#include <stdexcept>
#include <tuple>
#ifdef AINVR_CROP_GLES
#include "gles_context.h"
#endif
namespace ainvr {
namespace {
std::atomic<uint64_t> map_count{0},hit_count{0},crop_count{0},failure_count{0};
std::atomic<uint64_t> contexts_created{0},contexts_reused{0},contexts_live{0},shader_compilations{0};
constexpr double pi=3.14159265358979323846;
#ifdef AINVR_CROP_GLES
struct PreviousContext {
  EGLDisplay display=eglGetCurrentDisplay();
  EGLContext context=eglGetCurrentContext();
  EGLSurface draw=eglGetCurrentSurface(EGL_DRAW),read=eglGetCurrentSurface(EGL_READ);
  ~PreviousContext(){
    if(display!=EGL_NO_DISPLAY)eglMakeCurrent(display,draw,read,context);
    else if(auto d=eglGetCurrentDisplay();d!=EGL_NO_DISPLAY)
      eglMakeCurrent(d,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
  }
};
struct Context {
  hw_gl gl{};
  std::recursive_mutex mutex;
  std::atomic<bool> healthy{true};
  GLuint program=0,coefficients=0;
  Context(){PreviousContext previous;if(hw_gl_open(&gl)){hw_gl_close(&gl);throw std::runtime_error("Mali crop context unavailable");}
    ++contexts_created;++contexts_live;}
  void EnsureResources();
  ~Context(){PreviousContext previous;
    if(eglMakeCurrent(gl.display,gl.surface,gl.surface,gl.context)){
      if(program)glDeleteProgram(program);if(coefficients)glDeleteBuffers(1,&coefficients);
    }
    hw_gl_close(&gl);--contexts_live;
  }
};
std::shared_ptr<Context> AcquireContext(){
  // Archive targets are short-lived, but their four executor threads persist.
  // Retain only one current device context per calling thread. Map LRU caches,
  // uploaded textures and target buffers remain owned by each backend instance.
  struct Cache { std::string node; std::shared_ptr<Context> context; };
  static thread_local Cache cache;
  const char* value=std::getenv("AINVR_DRM_RENDER_NODE");
  const std::string node=value?value:"";
  if(cache.context && cache.node==node && cache.context->healthy.load()){
    ++contexts_reused;return cache.context;
  }
  auto next=std::make_shared<Context>();
  cache.context=next;cache.node=node;return next;
}
struct Active {
  std::unique_lock<std::recursive_mutex> lock;
  PreviousContext previous;
  explicit Active(Context& c):lock(c.mutex){
    if(!eglMakeCurrent(c.gl.display,c.gl.surface,c.gl.surface,c.gl.context)){
      c.healthy.store(false);
      throw std::runtime_error("Crop GPU context activation failed");
    }
  }
};
void Check(Context& context){if(auto e=glGetError();e!=GL_NO_ERROR){
  context.healthy.store(false);throw std::runtime_error("Crop GLES error "+std::to_string(e));}}
const char* shader=R"GLSL(#version 310 es
precision highp float;
precision highp int;
layout(local_size_x=16,local_size_y=16) in;
layout(binding=0) uniform highp sampler2D input_image;
layout(std430,binding=0) buffer Map { vec2 coordinates[]; };
layout(std430,binding=1) buffer Small { uint intermediate[]; };
layout(std430,binding=2) buffer Output { uint pixels[]; };
layout(std430,binding=3) buffer Bounds { uint xmin,ymin,xmax,ymax,invalid; };
layout(std430,binding=4) readonly buffer Coefficients { int table[]; };
uniform int operation;
uniform ivec2 input_size,output_size,map_size,erp_size,origin;
uniform ivec4 rectangle;
uniform mat3 rotation;
uniform vec2 focal;
const float PI=3.14159265358979323846;
int idx(ivec2 p,ivec2 size){return p.y*size.x+p.x;}
ivec4 source(ivec2 p){return ivec4(roundEven(texelFetch(input_image,clamp(p,ivec2(0),input_size-1),0)*255.0));}
uint pack(ivec4 v){uvec4 a=uvec4(clamp(v,ivec4(0),ivec4(255)));return a.x|(a.y<<8)|(a.z<<16)|(a.w<<24);}
ivec4 unpack(uint v){return ivec4(v&255u,(v>>8)&255u,(v>>16)&255u,(v>>24)&255u);}
float cubic(float distance){float t=abs(distance),a=-.75;if(t<=1.)return ((a+2.)*t-(a+3.))*t*t+1.;if(t<2.)return ((a*t-5.*a)*t+8.*a)*t-4.*a;return 0.;}
vec4 weights(float t){vec4 c=vec4(cubic(1.+t),cubic(t),cubic(1.-t),0.);c.w=1.-c.x-c.y-c.z;return c;}
void main(){
  ivec2 p=ivec2(gl_GlobalInvocationID.xy);if(any(greaterThanEqual(p,output_size)))return;
  int i=idx(p,output_size);
  if(operation==0){
    // Pixel centers follow the original map convention: u,v, without +0.5.
    vec2 camera=(vec2(p)-vec2(output_size)*.5)/focal;
    vec3 world=rotation*vec3(camera.x,-camera.y,1.);
    float longitude=atan(world.x,world.z);
    // atan(Y,hypot(X,Z)) is equivalent to asin(Y/length(world)), and remains
    // stable at the panorama poles with float32 hardware arithmetic.
    float latitude=atan(world.y,length(world.xz));
    vec2 uv=vec2(fract(longitude/(2.*PI)+.5)*float(erp_size.x),
                 clamp((.5-latitude/PI)*float(erp_size.y),0.,float(erp_size.y-1)));
    coordinates[i]=uv;
    if(any(isnan(uv))||any(isinf(uv))){atomicOr(invalid,1u);return;}
    atomicMin(xmin,floatBitsToUint(uv.x));atomicMin(ymin,floatBitsToUint(uv.y));
    atomicMax(xmax,floatBitsToUint(uv.x));atomicMax(ymax,floatBitsToUint(uv.y));
  }else if(operation==1){
    vec2 ratio=vec2(rectangle.zw)/vec2(output_size);
    vec2 begin=vec2(p)*ratio,end=vec2(p+1)*ratio;
    vec4 sum=vec4(0.);
    for(int y=int(floor(begin.y));y<int(ceil(end.y));++y)
      for(int x=int(floor(begin.x));x<int(ceil(end.x));++x){
        float weight=max(0.,min(end.x,float(x+1))-max(begin.x,float(x)))*
                     max(0.,min(end.y,float(y+1))-max(begin.y,float(y)));
        sum+=vec4(source(rectangle.xy+ivec2(x,y)))*weight;
      }
    pixels[i]=pack(ivec4(roundEven(sum/(ratio.x*ratio.y))));
  }else if(operation==2){
    vec2 uv=vec2(rectangle.xy)+(vec2(p)+.5)*vec2(rectangle.zw)/vec2(output_size)-.5;
    ivec2 quant=ivec2(roundEven(uv*32.)),base=quant>>5;
    ivec2 fraction=quant&31;ivec4 sum=ivec4(0);
    for(int y=0;y<2;++y)for(int x=0;x<2;++x){
      int weight=(x==0?32-fraction.x:fraction.x)*(y==0?32-fraction.y:fraction.y);
      sum+=source(base+ivec2(x,y))*weight;
    }
    pixels[i]=pack((sum+512)>>10);
  }else if(operation==3){
    ivec2 quant=ivec2(roundEven(coordinates[i]*32.));
    ivec2 base=(quant>>5)-origin-1;
    int offset=((quant.y&31)*32+(quant.x&31))*16;
    ivec4 sum=ivec4(0);
    for(int y=0;y<4;++y)for(int x=0;x<4;++x)
      sum+=source(base+ivec2(x,y))*table[offset+y*4+x];
    intermediate[i]=pack((sum+16384)>>15);
  }else if(operation==4){
    vec2 uv=(vec2(p)+.5)*vec2(map_size)/vec2(output_size)-.5;
    ivec2 base=ivec2(floor(uv));vec2 fraction=uv-vec2(base);
    ivec4 wx=ivec4(roundEven(weights(fraction.x)*2048.));
    ivec4 wy=ivec4(roundEven(weights(fraction.y)*2048.));
    ivec4 sum=ivec4(0);
    for(int y=0;y<4;++y)for(int x=0;x<4;++x){
      ivec2 q=clamp(base+ivec2(x-1,y-1),ivec2(0),map_size-1);
      sum+=unpack(intermediate[idx(q,map_size)])*(wx[x]*wy[y]);
    }
    pixels[i]=pack((sum+2097152)>>22);
  }
})GLSL";
float Cubic(float t){t=std::abs(t);constexpr float a=-.75f;
  if(t<=1)return ((a+2)*t-(a+3))*t*t+1;
  if(t<2)return ((a*t-5*a)*t+8*a)*t-4*a;
  return 0;
}
std::array<float,4> Weights(float t){std::array<float,4> c{Cubic(t+1),Cubic(t),Cubic(1-t),0};c[3]=1-c[0]-c[1]-c[2];return c;}
std::vector<int32_t> CoefficientTable(){
  // Image-independent interpolation LUT. Match 32 fractions and signed
  // 15-bit weights, including the original integer sum correction.
  std::vector<int32_t> table(32*32*16);
  for(int y=0;y<32;++y)for(int x=0;x<32;++x){
    auto a=Weights(float(x)/32),b=Weights(float(y)/32);int sum=0;
    auto* row=table.data()+(y*32+x)*16;
    for(int v=0;v<4;++v)for(int u=0;u<4;++u){
      row[v*4+u]=std::clamp(int(std::nearbyint((b[v]*a[u])*32768)),-32768,32767);sum+=row[v*4+u];
    }
    int low=10,high=10;
    for(int v=2;v<4;++v)for(int u=2;u<4;++u){int i=v*4+u;
      if(row[i]<row[low])low=i;else if(row[i]>row[high])high=i;
    }
    if(sum!=32768)row[sum<32768?high:low]-=sum-32768;
  }
  return table;
}
void Context::EnsureResources(){
  if(program)return;
  GLuint compute=0;
  try{
    compute=glCreateShader(GL_COMPUTE_SHADER);glShaderSource(compute,1,&shader,nullptr);glCompileShader(compute);
    GLint ok=0;glGetShaderiv(compute,GL_COMPILE_STATUS,&ok);
    if(!ok){char message[4096]{};glGetShaderInfoLog(compute,sizeof(message),nullptr,message);throw std::runtime_error(message);}
    program=glCreateProgram();glAttachShader(program,compute);glLinkProgram(program);
    glDeleteShader(compute);compute=0;glGetProgramiv(program,GL_LINK_STATUS,&ok);
    if(!ok){char message[4096]{};glGetProgramInfoLog(program,sizeof(message),nullptr,message);throw std::runtime_error(message);}
    glGenBuffers(1,&coefficients);
    auto table=CoefficientTable();glBindBuffer(GL_SHADER_STORAGE_BUFFER,coefficients);
    glBufferData(GL_SHADER_STORAGE_BUFFER,table.size()*sizeof(int32_t),table.data(),GL_STATIC_DRAW);
    Check(*this);++shader_compilations;
  }catch(...){
    healthy.store(false);if(compute)glDeleteShader(compute);
    if(program)glDeleteProgram(program);if(coefficients)glDeleteBuffers(1,&coefficients);
    program=coefficients=0;throw;
  }
}
#endif
}
#ifdef AINVR_CROP_GLES
struct GlesErpMap::Storage {
  std::shared_ptr<Context> context;
  std::shared_ptr<void> owner;
  GLuint buffer=0;
  ~Storage(){if(buffer)try{Active active(*context);glDeleteBuffers(1,&buffer);}catch(...) {}}
};
struct GlesCropBackend::State {
  std::shared_ptr<Context> context=AcquireContext();
  std::shared_ptr<void> owner=std::make_shared<int>(0);
  using Key=std::tuple<int,int,int64_t,int64_t,int64_t,int,int>;
  std::list<std::pair<Key,std::shared_ptr<GlesErpMap>>> lru;
  std::map<Key,decltype(lru)::iterator> index;
  size_t bytes=0,max_entries,max_bytes;
  GLuint program=0,texture=0,small=0,output=0,bounds=0,coefficients=0;
  cv::Size input_size;
  State(size_t entries,size_t budget):max_entries(entries),max_bytes(budget){
    Active active(*context);
    try {
      context->EnsureResources();program=context->program;coefficients=context->coefficients;
      glGenTextures(1,&texture);glGenBuffers(1,&small);glGenBuffers(1,&output);glGenBuffers(1,&bounds);
      Check(*context);
      Buffer(small,8);Buffer(output,4);Buffer(bounds,20);
    }catch(...){Destroy();throw;}
  }
  ~State(){try{Active active(*context);lru.clear();Destroy();}catch(...) {}}
  void Destroy(){if(texture)glDeleteTextures(1,&texture);for(GLuint b:{small,output,bounds})if(b)glDeleteBuffers(1,&b);}
  void Buffer(GLuint id,size_t bytes,const void* data=nullptr){
    GLint64 limit=0;glGetInteger64v(GL_MAX_SHADER_STORAGE_BLOCK_SIZE,&limit);
    if(bytes>size_t(limit))throw std::invalid_argument("Crop buffer exceeds GPU limit");
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,id);glBufferData(GL_SHADER_STORAGE_BUFFER,bytes,data,GL_DYNAMIC_DRAW);
  }
  GLint Uniform(const char* name){return glGetUniformLocation(program,name);}
  void Size(const char* name,cv::Size value){glUniform2i(Uniform(name),value.width,value.height);}
  void Dispatch(int op,cv::Size size){
    glUniform1i(Uniform("operation"),op);Size("output_size",size);
    glDispatchCompute((size.width+15)/16,(size.height+15)/16,1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT|GL_BUFFER_UPDATE_BARRIER_BIT);Check(*context);
  }
  void Bind(){glUseProgram(program);Size("input_size",input_size);glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,texture);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,0,coefficients);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,1,small);glBindBufferBase(GL_SHADER_STORAGE_BUFFER,2,output);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,3,bounds);glBindBufferBase(GL_SHADER_STORAGE_BUFFER,4,coefficients);
  }
  cv::Mat Read(cv::Size size){
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,output);size_t bytes=size_t(size.width)*size.height*4;
    auto* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,bytes,GL_MAP_READ_BIT);
    if(!data)throw std::runtime_error("Crop output readback failed");
    cv::Mat result(size,CV_8UC4);std::memcpy(result.data,data,bytes);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("Crop output corrupted");
    Check(*context);++crop_count;return result;
  }
};
#else
struct GlesCropBackend::State {};
struct GlesErpMap::Storage {};
#endif
GlesCropStats GetGlesCropStats(){return {map_count.load(),hit_count.load(),crop_count.load(),failure_count.load(),
  contexts_created.load(),contexts_reused.load(),contexts_live.load(),shader_compilations.load()};}
GlesCropBackend::GlesCropBackend(size_t entries,size_t budget){
  if(!entries||!budget)throw std::invalid_argument("Invalid crop cache budget");
#ifdef AINVR_CROP_GLES
  try{state_=std::make_unique<State>(entries,budget);}catch(...){++failure_count;throw;}
#else
  ++failure_count;throw std::runtime_error("Hardware crop backend unavailable");
#endif
}
GlesCropBackend::~GlesCropBackend()=default;
std::shared_ptr<const GlesErpMap> GlesCropBackend::GetMap(cv::Size source,const ai_service::output::ErpView& v){
#ifdef AINVR_CROP_GLES
  if(source.width<=0||source.height<=0||source.width>8192||source.height>8192||v.w_out<=0||v.h_out<=0||
     size_t(v.w_out)*v.h_out*8>(size_t(32)<<20)||!std::isfinite(v.cx)||!std::isfinite(v.cy)||
     std::abs(v.cx)>131072||std::abs(v.cy)>131072||
     !std::isfinite(v.fov_h_deg)||v.fov_h_deg<=0||v.fov_h_deg>=180)
    throw std::invalid_argument("Invalid ERP GPU map dimensions/view");
  auto& s=*state_;Active active(*s.context);
  try {
    State::Key key{source.width,source.height,int64_t(std::nearbyint((v.cx/source.width-.5)*120)),
      int64_t(std::nearbyint((.5-v.cy/source.height)*60)),int64_t(std::nearbyint(v.fov_h_deg/3)),v.w_out,v.h_out};
    if(auto i=s.index.find(key);i!=s.index.end()){s.lru.splice(s.lru.end(),s.lru,i->second);++hit_count;return i->second->second;}
    auto map=std::make_shared<GlesErpMap>();map->source_size=source;map->size={v.w_out,v.h_out};
    map->storage=std::make_shared<GlesErpMap::Storage>();map->storage->context=s.context;map->storage->owner=s.owner;
    glGenBuffers(1,&map->storage->buffer);const size_t bytes=size_t(v.w_out)*v.h_out*8;
    s.Buffer(map->storage->buffer,bytes);
    const uint32_t init[5]={0xffffffffu,0xffffffffu,0,0,0};s.Buffer(s.bounds,sizeof(init),init);s.Bind();s.Size("erp_size",source);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,0,map->storage->buffer);
    const double yaw=(v.cx/source.width-.5)*2*pi,pitch=(.5-v.cy/source.height)*pi;
    const double cy=std::cos(yaw),sy=std::sin(yaw),cp=std::cos(pitch),sp=std::sin(pitch);
    const float rotation[9]={float(cy),0,float(-sy),float(-sy*sp),float(cp),float(-cy*sp),float(sy*cp),float(sp),float(cy*cp)};
    glUniformMatrix3fv(s.Uniform("rotation"),1,GL_FALSE,rotation);
    const double fx=(v.w_out/2.)/std::tan(v.fov_h_deg*pi/360.);
    glUniform2f(s.Uniform("focal"),float(fx),float(fx));s.Dispatch(0,map->size);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER,s.bounds);auto* data=glMapBufferRange(GL_SHADER_STORAGE_BUFFER,0,sizeof(init),GL_MAP_READ_BIT);
    if(!data)throw std::runtime_error("ERP GPU bounds readback failed");
    float limits[4];uint32_t invalid;std::memcpy(limits,data,sizeof(limits));std::memcpy(&invalid,static_cast<const uint8_t*>(data)+16,4);
    if(!glUnmapBuffer(GL_SHADER_STORAGE_BUFFER))throw std::runtime_error("ERP bounds corrupted");
    map->finite=!invalid;
    if(map->finite){int left=int(std::clamp(std::floor(limits[0])-2.,0.,double(source.width-1)));
      int top=int(std::clamp(std::floor(limits[1])-2.,0.,double(source.height-1)));
      int right=int(std::clamp(std::ceil(limits[2])+3.,double(left+1),double(source.width)));
      int bottom=int(std::clamp(std::ceil(limits[3])+3.,double(top+1),double(source.height)));
      map->required={left,top,right-left,bottom-top};}
    s.lru.emplace_back(key,map);s.index[key]=std::prev(s.lru.end());s.bytes+=bytes;
    while(s.lru.size()>1&&(s.lru.size()>s.max_entries||s.bytes>s.max_bytes)){
      auto& first=s.lru.front();s.bytes-=size_t(first.second->size.width)*first.second->size.height*8;
      s.index.erase(first.first);s.lru.pop_front();
    }
    Check(*s.context);++map_count;return map;
  }catch(...){++failure_count;throw;}
#else
  throw std::runtime_error("Hardware crop backend unavailable");
#endif
}
void GlesCropBackend::Upload(const cv::Mat& rgba){
#ifdef AINVR_CROP_GLES
  if(rgba.empty()||rgba.type()!=CV_8UC4||rgba.cols>8192||rgba.rows>8192||rgba.total()*4>(size_t(256)<<20))
    throw std::invalid_argument("Crop requires bounded RGBA8 source");
  auto& s=*state_;Active active(*s.context);
  try{GLint limit=0;glGetIntegerv(GL_MAX_TEXTURE_SIZE,&limit);
    if(rgba.cols>limit||rgba.rows>limit)throw std::invalid_argument("Crop source exceeds texture limit");
    cv::Mat packed=rgba.isContinuous()?rgba:rgba.clone(); // Byte copy only.
    glActiveTexture(GL_TEXTURE0);glBindTexture(GL_TEXTURE_2D,s.texture);
    glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MIN_FILTER,GL_NEAREST);glTexParameteri(GL_TEXTURE_2D,GL_TEXTURE_MAG_FILTER,GL_NEAREST);
    glPixelStorei(GL_UNPACK_ALIGNMENT,1);glTexImage2D(GL_TEXTURE_2D,0,GL_RGBA8,rgba.cols,rgba.rows,0,GL_RGBA,GL_UNSIGNED_BYTE,packed.data);
    s.input_size=rgba.size();Check(*s.context);
  }catch(...){++failure_count;throw;}
#else
  throw std::runtime_error("Hardware crop backend unavailable");
#endif
}
namespace {
void ValidateOutput(cv::Size output){if(output.width<=0||output.height<=0||output.width>8192||output.height>8192||
  size_t(output.width)*output.height*4>(size_t(128)<<20))throw std::invalid_argument("Invalid crop output budget");}
}
cv::Mat GlesCropBackend::Area(const cv::Rect& region,cv::Size output,bool linear){
  ValidateOutput(output);
#ifdef AINVR_CROP_GLES
  if(region.width<=0||region.height<=0||region.width>131072||region.height>131072||
     std::abs(int64_t(region.x))>131072||std::abs(int64_t(region.y))>131072)
    throw std::invalid_argument("Invalid crop rectangle");
  auto& s=*state_;Active active(*s.context);
  if(s.input_size.empty())throw std::logic_error("Crop source not uploaded");
  try{s.Buffer(s.output,size_t(output.width)*output.height*4);s.Bind();
    glUniform4i(s.Uniform("rectangle"),region.x,region.y,region.width,region.height);
    s.Dispatch(linear?2:1,output);return s.Read(output);
  }catch(...){++failure_count;throw;}
#else
  throw std::runtime_error("Hardware crop backend unavailable");
#endif
}
cv::Mat GlesCropBackend::Remap(const std::shared_ptr<const GlesErpMap>& map,cv::Point origin,cv::Size output){
  ValidateOutput(output);
#ifdef AINVR_CROP_GLES
  auto& s=*state_;Active active(*s.context);
  if(!map||!map->finite||!map->storage||map->storage->context!=s.context||map->storage->owner!=s.owner||s.input_size.empty()||origin.x<0||origin.y<0||
     origin.x+s.input_size.width>map->source_size.width||origin.y+s.input_size.height>map->source_size.height)
    throw std::invalid_argument("Invalid ERP map or ROI origin");
  try{s.Buffer(s.small,size_t(map->size.width)*map->size.height*4);s.Buffer(s.output,size_t(output.width)*output.height*4);s.Bind();
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER,0,map->storage->buffer);
    glUniform2i(s.Uniform("origin"),origin.x,origin.y);s.Size("map_size",map->size);
    s.Dispatch(3,map->size);s.Dispatch(4,output);return s.Read(output);
  }catch(...){++failure_count;throw;}
#else
  throw std::runtime_error("Hardware crop backend unavailable");
#endif
}
size_t GlesCropBackend::CacheSize()const{
#ifdef AINVR_CROP_GLES
  std::lock_guard<std::recursive_mutex> lock(state_->context->mutex);return state_->lru.size();
#else
  return 0;
#endif
}
size_t GlesCropBackend::CacheBytes()const{
#ifdef AINVR_CROP_GLES
  std::lock_guard<std::recursive_mutex> lock(state_->context->mutex);return state_->bytes;
#else
  return 0;
#endif
}
}

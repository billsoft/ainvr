// Copyright AINVR.
#include "raw_frame_spool.hpp"
#include <openssl/sha.h>
#include <filesystem>
#include <array>
#include <map>
#include <mutex>
#include <cstring>
#include <algorithm>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace ainvr {namespace {
constexpr size_t header_size=68,meta_limit=1024*1024,pixel_limit=size_t(8192)*8192*3/2;
struct Fd{int n;explicit Fd(int v=-1):n(v){}~Fd(){if(n>=0)close(n);}Fd(const Fd&)=delete;};
void Check(bool ok){if(!ok)throw std::runtime_error("Raw archive I/O failed");}
void Id(const std::string&id){if(id.size()!=24||!std::all_of(id.begin(),id.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');}))throw std::invalid_argument("Invalid raw task ID");}
void Write(int fd,const void*bytes,size_t size){auto p=static_cast<const uint8_t*>(bytes);while(size){auto n=write(fd,p,size);if(n<0&&errno==EINTR)continue;Check(n>0);p+=n;size-=n;}}
void Read(int fd,void*bytes,size_t size){auto p=static_cast<uint8_t*>(bytes);while(size){auto n=read(fd,p,size);if(n<0&&errno==EINTR)continue;Check(n>0);p+=n;size-=n;}}
void Put(uint8_t*p,uint64_t n,size_t size){for(size_t i=0;i<size;++i)p[i]=uint8_t(n>>(8*i));}
uint64_t Get(const uint8_t*p,size_t size){uint64_t n=0;for(size_t i=0;i<size;++i)n|=uint64_t(p[i])<<(8*i);return n;}
void Validate(const RawFrameTask&t){auto w=t.frame.width,h=t.frame.height;
 if(w<=0||h<=0||w>8192||h>8192||w%2||h%2||t.frame.pixels.size()!=size_t(w)*h*3/2||!t.metadata.is_object())throw std::invalid_argument("Invalid raw archive frame");}
std::array<uint8_t,32> Digest(const std::array<uint8_t,header_size>& header,const std::string&meta,const std::vector<uint8_t>&pixels){
 SHA256_CTX ctx;SHA256_Init(&ctx);SHA256_Update(&ctx,header.data(),36);SHA256_Update(&ctx,meta.data(),meta.size());SHA256_Update(&ctx,pixels.data(),pixels.size());std::array<uint8_t,32> out{};SHA256_Final(out.data(),&ctx);return out;
}
RawFrameTask Load(int dir,const std::string&id){
 Fd file(openat(dir,(id+".pending").c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW));Check(file.n>=0);
 struct stat st{};Check(fstat(file.n,&st)==0&&S_ISREG(st.st_mode));
 if(st.st_size<ssize_t(header_size)||st.st_size>ssize_t(header_size+meta_limit+pixel_limit))throw std::runtime_error("Invalid raw task size");
 std::array<uint8_t,header_size> header{};Read(file.n,header.data(),header.size());
 if(std::memcmp(header.data(),"AINVRRW1",8))throw std::runtime_error("Unknown raw task format");
 auto m=Get(header.data()+16,4),n=Get(header.data()+20,8);
 if(m>meta_limit||n>pixel_limit||uint64_t(st.st_size)!=header_size+m+n)throw std::runtime_error("Invalid raw task lengths");
 RawFrameTask t;t.frame.width=Get(header.data()+8,4);t.frame.height=Get(header.data()+12,4);t.frame.pts=Get(header.data()+28,8);
 std::string meta(m,'\0');t.frame.pixels.resize(n);Read(file.n,meta.data(),m);Read(file.n,t.frame.pixels.data(),n);
 auto hash=Digest(header,meta,t.frame.pixels);if(std::memcmp(hash.data(),header.data()+36,32))throw std::runtime_error("Raw task checksum failed; task retained");
 t.metadata=nlohmann::json::parse(meta);Validate(t);return t;
}
}
struct RawFrameSpool::State{Fd dir,lock;size_t limit,count,bytes=0;std::map<std::string,size_t> pending;std::mutex mutex;State(size_t b,size_t n):limit(b),count(n){}};
RawFrameSpool::RawFrameSpool(const std::string&directory,size_t max_bytes,size_t max_tasks):state_(std::make_unique<State>(max_bytes,max_tasks)){
 if(max_bytes<=header_size||!max_tasks)throw std::invalid_argument("Invalid raw spool capacity");
 auto path=std::filesystem::absolute(directory);bool created=mkdir(path.c_str(),0700)==0;Check(created||errno==EEXIST);
 auto&s=*state_;s.dir.n=open(path.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);Check(s.dir.n>=0);
 s.lock.n=openat(s.dir.n,".lock",O_CREAT|O_RDWR|O_CLOEXEC|O_NOFOLLOW,0600);Check(s.lock.n>=0);Check(flock(s.lock.n,LOCK_EX|LOCK_NB)==0);
 if(created){Fd parent(open(path.parent_path().c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC));Check(parent.n>=0);Check(fsync(parent.n)==0);}
 for(const auto&e:std::filesystem::directory_iterator(path)){
  if(e.path().filename()==".lock")continue;
  if(e.is_symlink()||!e.is_regular_file())throw std::runtime_error("Unexpected raw spool entry");
  auto id=e.path().stem().string();Id(id);
  if(e.path().extension()==".tmp"){Check(unlinkat(s.dir.n,e.path().filename().c_str(),0)==0);continue;}
  if(e.path().extension()!=".pending")throw std::runtime_error("Unknown raw spool file");
  Load(s.dir.n,id);auto size=e.file_size();s.pending.emplace(id,size);s.bytes+=size;
 }
 Check(fsync(s.dir.n)==0);
}
RawFrameSpool::~RawFrameSpool()=default;
void RawFrameSpool::Stage(const std::string&id,const RawFrameTask&task){
 Id(id);Validate(task);auto meta=task.metadata.dump();if(meta.size()>meta_limit)throw std::invalid_argument("Raw task metadata too large");
 auto&s=*state_;std::lock_guard guard(s.mutex);
 if(s.pending.count(id)){
  auto old=Load(s.dir.n,id);
  if(old.metadata!=task.metadata||old.frame.width!=task.frame.width||old.frame.height!=task.frame.height||old.frame.pts!=task.frame.pts||old.frame.pixels!=task.frame.pixels)throw std::invalid_argument("Raw task ID collision");
  Check(fsync(s.dir.n)==0);return;
 }
 size_t size=header_size+meta.size()+task.frame.pixels.size();
 if(s.pending.size()>=s.count||size>s.limit||s.bytes>s.limit-size)throw std::runtime_error("Raw archive full; retain frame and backpressure");
 std::array<uint8_t,header_size> header{};std::memcpy(header.data(),"AINVRRW1",8);
 Put(header.data()+8,task.frame.width,4);Put(header.data()+12,task.frame.height,4);Put(header.data()+16,meta.size(),4);
 Put(header.data()+20,task.frame.pixels.size(),8);Put(header.data()+28,task.frame.pts,8);
 auto hash=Digest(header,meta,task.frame.pixels);std::copy(hash.begin(),hash.end(),header.begin()+36);
 auto temp=id+".tmp",target=id+".pending";auto entry=s.pending.emplace(id,size).first;bool renamed=false;
 try{
  Fd f(openat(s.dir.n,temp.c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NOFOLLOW,0600));Check(f.n>=0);
  Write(f.n,header.data(),header.size());Write(f.n,meta.data(),meta.size());Write(f.n,task.frame.pixels.data(),task.frame.pixels.size());
  Check(fsync(f.n)==0);Check(renameat(s.dir.n,temp.c_str(),s.dir.n,target.c_str())==0);renamed=true;s.bytes+=size;Check(fsync(s.dir.n)==0);
 }catch(...){if(!renamed)s.pending.erase(entry);throw;}
}
std::vector<std::string> RawFrameSpool::Pending(){auto&s=*state_;std::lock_guard guard(s.mutex);std::vector<std::string> result;for(auto&p:s.pending)result.push_back(p.first);return result;}
void RawFrameSpool::Deliver(const std::string&id,const std::function<void(const RawFrameTask&)>&accept){
 Id(id);auto&s=*state_;std::lock_guard guard(s.mutex);auto it=s.pending.find(id);if(it==s.pending.end())throw std::invalid_argument("Unknown raw archive task");
 auto task=Load(s.dir.n,id);accept(task);Check(unlinkat(s.dir.n,(id+".pending").c_str(),0)==0);s.bytes-=it->second;s.pending.erase(it);Check(fsync(s.dir.n)==0);
}
}

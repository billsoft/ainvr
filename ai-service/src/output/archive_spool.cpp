// Copyright AINVR. Linux durable storage for fully prepared archive BSON.
#include "archive_spool.hpp"
#include <bson/bson.h>
#include <openssl/sha.h>
#include <array>
#include <algorithm>
#include <cstring>
#include <cerrno>
#include <filesystem>
#include <map>
#include <mutex>
#include <stdexcept>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
namespace ainvr {
namespace {
constexpr size_t overhead=40,limit=16*1024*1024;
constexpr char magic[]="AINVRSP1";
struct Fd {int value=-1;explicit Fd(int v=-1):value(v){}~Fd(){if(value>=0)::close(value);}Fd(const Fd&)=delete;};
void Check(bool ok){if(!ok)throw std::runtime_error("Archive spool I/O failed errno="+std::to_string(errno));}
void Id(const std::string& id){if(id.size()!=24||!std::all_of(id.begin(),id.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}))throw std::invalid_argument("Invalid spool ID");}
void Validate(const std::string& id,const std::vector<uint8_t>& bytes){
  Id(id);bson_t doc;bson_iter_t it,name;
  if(bytes.empty()||bytes.size()>limit||!bson_init_static(&doc,bytes.data(),bytes.size())||!bson_validate(&doc,BSON_VALIDATE_UTF8,nullptr)||
     !bson_iter_init_find(&it,&doc,"_id")||!BSON_ITER_HOLDS_OID(&it)||!bson_iter_init_find(&name,&doc,"image_id")||!BSON_ITER_HOLDS_UTF8(&name))
    throw std::invalid_argument("Invalid spool BSON");
  char oid[25];bson_oid_to_string(bson_iter_oid(&it),oid);
  if(id!=oid||id!=bson_iter_utf8(&name,nullptr))throw std::invalid_argument("Spool ID mismatch");
}
std::vector<uint8_t> Read(int directory,const std::string& id){
  Fd file(openat(directory,(id+".pending").c_str(),O_RDONLY|O_CLOEXEC|O_NOFOLLOW));Check(file.value>=0);
  struct stat st{};Check(fstat(file.value,&st)==0);
  if(!S_ISREG(st.st_mode)||st.st_size<ssize_t(overhead)||st.st_size>ssize_t(limit+overhead))throw std::runtime_error("Invalid spool envelope size");
  std::vector<uint8_t> envelope(st.st_size);size_t offset=0;
  while(offset<envelope.size()){auto n=read(file.value,envelope.data()+offset,envelope.size()-offset);if(n<0&&errno==EINTR)continue;Check(n>0);offset+=n;}
  std::vector<uint8_t> bytes(envelope.begin()+overhead,envelope.end());std::array<uint8_t,SHA256_DIGEST_LENGTH> hash{};SHA256(bytes.data(),bytes.size(),hash.data());
  if(std::memcmp(envelope.data(),magic,8)||std::memcmp(envelope.data()+8,hash.data(),hash.size()))throw std::runtime_error("Archive spool checksum mismatch; file retained");
  Validate(id,bytes);return bytes;
}
}
struct ArchiveSpool::State {
  Fd directory,lock;size_t max_bytes,max_records,bytes=0;std::map<std::string,size_t> pending;std::mutex mutex;
  State(size_t b,size_t n):max_bytes(b),max_records(n){}
};
ArchiveSpool::ArchiveSpool(const std::string& directory,size_t max_bytes,size_t max_records):state_(std::make_unique<State>(max_bytes,max_records)){
  if(max_bytes<overhead+5||!max_records)throw std::invalid_argument("Invalid spool capacity");
  auto path=std::filesystem::absolute(directory);bool created=mkdir(path.c_str(),0700)==0;
  if(!created&&errno!=EEXIST)Check(false);
  auto& s=*state_;s.directory.value=open(path.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);Check(s.directory.value>=0);
  s.lock.value=openat(s.directory.value,".lock",O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);Check(s.lock.value>=0);
  Check(flock(s.lock.value,LOCK_EX|LOCK_NB)==0);
  if(created){Fd parent(open(path.parent_path().c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC));Check(parent.value>=0);Check(fsync(parent.value)==0);}
  // Only uncommitted temporary files are removed. Stage never acknowledges a
  // .tmp file; confirmed .pending records are never discarded during recovery.
  for(const auto& entry:std::filesystem::directory_iterator(path)){
    auto name=entry.path().filename().string();if(name==".lock")continue;
    if(!entry.is_regular_file()||entry.is_symlink())throw std::runtime_error("Unexpected spool entry");
    auto id=entry.path().stem().string();Id(id);
    if(entry.path().extension()==".tmp"){Check(unlinkat(s.directory.value,name.c_str(),0)==0);continue;}
    if(entry.path().extension()!=".pending")throw std::runtime_error("Unexpected spool filename");
    auto data=Read(s.directory.value,id);size_t size=data.size()+overhead;s.pending.emplace(id,size);s.bytes+=size;
  }
  Check(fsync(s.directory.value)==0);
}
ArchiveSpool::~ArchiveSpool()=default;
void ArchiveSpool::Stage(const std::string& id,const std::vector<uint8_t>& bytes){
  Validate(id,bytes);auto& s=*state_;std::lock_guard guard(s.mutex);
  if(s.pending.count(id)){
    if(Read(s.directory.value,id)!=bytes)throw std::invalid_argument("Existing spool ID has different content");
    Check(fsync(s.directory.value)==0);return;
  }
  if(s.pending.size()>=s.max_records||bytes.size()+overhead>s.max_bytes||s.bytes>s.max_bytes-bytes.size()-overhead)
    throw std::runtime_error("Archive spool full; retain caller record and backpressure");
  std::vector<uint8_t> envelope(overhead+bytes.size());std::memcpy(envelope.data(),magic,8);
  SHA256(bytes.data(),bytes.size(),envelope.data()+8);std::copy(bytes.begin(),bytes.end(),envelope.begin()+overhead);
  auto temp=id+".tmp",target=id+".pending";
  auto entry=s.pending.emplace(id,envelope.size()).first;bool renamed=false;
  try{
  Fd file(openat(s.directory.value,temp.c_str(),O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NOFOLLOW,0600));Check(file.value>=0);
  size_t offset=0;while(offset<envelope.size()){auto n=write(file.value,envelope.data()+offset,envelope.size()-offset);if(n<0&&errno==EINTR)continue;Check(n>0);offset+=n;}
  Check(fsync(file.value)==0);Check(renameat(s.directory.value,temp.c_str(),s.directory.value,target.c_str())==0);
  renamed=true;
  // Track the renamed file even if directory fsync fails; retries retain it.
  s.bytes+=envelope.size();Check(fsync(s.directory.value)==0);
  }catch(...){if(!renamed)s.pending.erase(entry);throw;}
}
std::vector<std::string> ArchiveSpool::Pending(){auto& s=*state_;std::lock_guard guard(s.mutex);std::vector<std::string> ids;for(auto& p:s.pending)ids.push_back(p.first);return ids;}
void ArchiveSpool::Deliver(const std::string& id,const std::function<void(const std::vector<uint8_t>&)>& callback){
  Id(id);auto& s=*state_;std::lock_guard guard(s.mutex);auto it=s.pending.find(id);if(it==s.pending.end())throw std::invalid_argument("Unknown pending ID");
  auto bytes=Read(s.directory.value,id);callback(bytes);
  Check(unlinkat(s.directory.value,(id+".pending").c_str(),0)==0);s.bytes-=it->second;s.pending.erase(it);Check(fsync(s.directory.value)==0);
}
}  // namespace ainvr

// Copyright AINVR. Private bounded copies of already-redacted warnings/errors.
#pragma once
#include <cerrno>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
namespace ai_service::log {
class WarningLog {
 public:
  explicit WarningLog(const std::filesystem::path& directory,size_t maximum=4*1024*1024):maximum_(maximum){
    if(maximum<16384||maximum>64*1024*1024)throw std::invalid_argument("Invalid diagnostic log bound");
    if(mkdir(directory.c_str(),0700)!=0&&errno!=EEXIST)throw std::runtime_error("Cannot create diagnostic log directory");
    directory_=open(directory.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    struct stat s{};
    if(directory_<0||fstat(directory_,&s)||s.st_uid!=geteuid()||(s.st_mode&077)!=0){Close();throw std::runtime_error("Diagnostic log directory must be private and owned");}
    try{CheckExisting("warnings.previous.jsonl");Open();}catch(...){Close();throw;}
  }
  ~WarningLog(){Close();}
  WarningLog(const WarningLog&)=delete;
  WarningLog& operator=(const WarningLog&)=delete;
  void Append(const std::string& line){
    if(line.size()+1>maximum_)throw std::runtime_error("Diagnostic event exceeds file bound");
    if(size_+line.size()+1>maximum_){
      CheckExisting("warnings.previous.jsonl");
      if(renameat(directory_,"warnings.jsonl",directory_,"warnings.previous.jsonl"))throw std::runtime_error("Diagnostic rotation failed");
      close(file_);file_=-1;Open();
    }
    const std::string record=line+'\n';size_t offset=0;
    while(offset<record.size()){
      const auto n=write(file_,record.data()+offset,record.size()-offset);
      if(n<0&&errno==EINTR)continue;
      if(n<=0)throw std::runtime_error("Diagnostic write failed");offset+=n;size_+=n;
    }
  }
 private:
  void CheckExisting(const char* name){
    struct stat s{};
    if(fstatat(directory_,name,&s,AT_SYMLINK_NOFOLLOW)){
      if(errno==ENOENT)return;throw std::runtime_error("Diagnostic file check failed");
    }
    if(!S_ISREG(s.st_mode)||s.st_uid!=geteuid()||s.st_nlink!=1||(s.st_mode&077)!=0)
      throw std::runtime_error("Unsafe diagnostic log file");
  }
  void Open(){
    CheckExisting("warnings.jsonl");
    file_=openat(directory_,"warnings.jsonl",O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_CLOEXEC,0600);
    struct stat s{};
    if(file_<0||fstat(file_,&s)||!S_ISREG(s.st_mode)||s.st_uid!=geteuid()||s.st_nlink!=1||(s.st_mode&077)!=0)
      throw std::runtime_error("Cannot open private diagnostic log");
    size_=s.st_size;
  }
  void Close(){if(file_>=0)close(file_);if(directory_>=0)close(directory_);file_=directory_=-1;}
  int directory_=-1,file_=-1;size_t maximum_,size_=0;
};
}

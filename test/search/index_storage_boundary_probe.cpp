// Explicit real-storage interface fixture only. No BPU, model, Mongo or PG.
// Never invoked by CTest. No mount/unmount/format or production configuration.
#include "index_shard_files.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cmath>
#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <regex>
#include <set>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>
using namespace ainvr::search;
using Json=nlohmann::json;
namespace fs=std::filesystem;
namespace {
const char* Usage(){return "Manual only: --run-storage-test --mount ACTUAL_MOUNT --volume-id RAW_UUID --storage-generation SHA256 --run-id UNIQUE --report test/results/NEW.json\n"
 "Relative path is fixed to ainvr-tests/search-index-<run-id>. Refuses an existing target.\n"
 "Uses real OpenProduction UUID/mount/generation checks and tiny quotas. Synthetic 3D vectors test storage only.\n"
 "No production index, model, database, mount, unmount or format operation. --help has no filesystem effect.\n";}
void Require(bool ok,const char* code){if(!ok)throw std::runtime_error(code);}
struct Fd {
 int fd=-1;explicit Fd(int value=-1):fd(value){}~Fd(){if(fd>=0)close(fd);}
 Fd(const Fd&)=delete;Fd& operator=(const Fd&)=delete;
};
struct stat Stat(int fd){struct stat value{};Require(fstat(fd,&value)==0,"storage_probe_stat_failed");return value;}
bool SameDirectory(const struct stat& a,const struct stat& b){return a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&S_ISDIR(b.st_mode)&&b.st_uid==geteuid()&&(b.st_mode&0777)==0700;}
void Sync(int fd){Require(fsync(fd)==0,"storage_probe_sync_failed");}
std::set<std::string> Names(int fd){
 Fd duplicate(openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));Require(duplicate.fd>=0,"storage_probe_directory_read_failed");
 DIR* dir=fdopendir(duplicate.fd);Require(dir!=nullptr,"storage_probe_directory_read_failed");duplicate.fd=-1;
 std::set<std::string> out;errno=0;
 while(auto* row=readdir(dir)){
  const std::string name=row->d_name;if(name!="."&&name!="..")out.insert(name);
  if(out.size()>16){closedir(dir);throw std::runtime_error("storage_probe_unexpected_directory_content");}errno=0;
 }
 const int error=errno;closedir(dir);Require(error==0,"storage_probe_directory_read_failed");return out;
}
void NewReport(const fs::path& path){
 const auto allowed=fs::canonical(AINVR_SEARCH_STORAGE_RESULTS_ROOT),parent=fs::canonical(path.parent_path());
 const auto relative=parent.lexically_relative(allowed);std::error_code error;
 const auto type=fs::symlink_status(path,error).type();
 Require(!relative.empty()&&!relative.is_absolute()&&*relative.begin()!=".."&&!path.filename().empty()&&type==fs::file_type::not_found,
   "storage_probe_report_must_be_new_under_results");
}
void WriteReport(const fs::path& path,const Json& value){
 Fd file(open(path.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600));Require(file.fd>=0,"storage_probe_report_create_failed");
 const auto text=value.dump(2)+"\n";size_t at=0;while(at<text.size()){
  const auto n=write(file.fd,text.data()+at,text.size()-at);Require(n>0,"storage_probe_report_write_failed");at+=size_t(n);
 }Sync(file.fd);
}
void Regular(int fd,dev_t device,uint64_t maximum){
 const auto st=Stat(fd);Require(S_ISREG(st.st_mode)&&st.st_uid==geteuid()&&st.st_nlink==1&&st.st_dev==device&&
   st.st_size>=0&&uint64_t(st.st_size)<=maximum&&(st.st_mode&0022)==0,"storage_probe_not_own_regular_file");
}
void CleanupFixture(int mount,int parent,int target,const std::string& basename,const std::string& volume,
    const struct stat& parent_identity,const struct stat& target_identity,bool created_parent){
 Require(std::regex_match(basename,std::regex("search-index-[A-Za-z0-9][A-Za-z0-9_-]{7,63}")),"storage_probe_cleanup_prefix_mismatch");
 struct stat current{};Require(fstatat(parent,basename.c_str(),&current,AT_SYMLINK_NOFOLLOW)==0&&
   SameDirectory(target_identity,current)&&SameDirectory(target_identity,Stat(target)),"storage_probe_cleanup_identity_changed");
 Require(Names(target)==std::set<std::string>{".owner.json",".writer.lock"},"storage_probe_cleanup_unexpected_content");
 Fd marker(openat(target,".owner.json",O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));Require(marker.fd>=0,"storage_probe_owner_missing");
 Regular(marker.fd,target_identity.st_dev,1024);const auto size=Stat(marker.fd).st_size;
 Require(size>0,"storage_probe_owner_invalid");std::string bytes(size_t(size),'\0');
 Require(pread(marker.fd,bytes.data(),bytes.size(),0)==ssize_t(bytes.size()),"storage_probe_owner_read_failed");
 const Json expected={{"schema_version",1},{"kind","ainvr-search-index"},{"volume_id",volume},{"test_only",false}};
 Require(Json::parse(bytes)==expected,"storage_probe_owner_marker_mismatch");
 Fd lock(openat(target,".writer.lock",O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));Require(lock.fd>=0,"storage_probe_lock_missing");
 Regular(lock.fd,target_identity.st_dev,0);Require(flock(lock.fd,LOCK_EX|LOCK_NB)==0,"storage_probe_fixture_still_busy");
 // Only these two known self-created marker files. Never recursive removal.
 Require(unlinkat(target,".owner.json",0)==0&&unlinkat(target,".writer.lock",0)==0,"storage_probe_marker_cleanup_failed");Sync(target);
 Require(fstatat(parent,basename.c_str(),&current,AT_SYMLINK_NOFOLLOW)==0&&SameDirectory(target_identity,current),"storage_probe_cleanup_identity_changed");
 Require(unlinkat(parent,basename.c_str(),AT_REMOVEDIR)==0,"storage_probe_fixture_directory_not_empty");Sync(parent);
 if(created_parent&&Names(parent).empty()){
  Require(fstatat(mount,"ainvr-tests",&current,AT_SYMLINK_NOFOLLOW)==0&&SameDirectory(parent_identity,current),"storage_probe_parent_identity_changed");
  Require(unlinkat(mount,"ainvr-tests",AT_REMOVEDIR)==0,"storage_probe_parent_cleanup_failed");Sync(mount);
 }
}
std::vector<Record> Records(const IndexShardIdentity& id){
 std::vector<Record> rows;for(int n=0;n<3;++n)rows.push_back({"storage-fixture-"+std::to_string(n),id.channel_id,"storage-fixture","storage-fixture",
  "fixture-track-"+std::to_string(n),id.model_version,86401000+n,false,n==1?std::vector<float>{0,3,4}:std::vector<float>{1,0,0},std::string(64,char('a'+n))});return rows;
}
}
int main(int argc,char** argv){
 fs::path report,fixture;std::string phase="arguments";bool report_valid=false;
 const auto start=std::chrono::steady_clock::now();
 try{
  if(argc==2&&std::string(argv[1])=="--help"){std::cout<<Usage();return 0;}
  if(argc<2||std::string(argv[1])!="--run-storage-test"){std::cerr<<Usage();return 64;}
  std::map<std::string,std::string> args;for(int n=2;n<argc;n+=2){Require(n+1<argc&&args.emplace(argv[n],argv[n+1]).second,"storage_probe_invalid_arguments");}
  Require(args.size()==5&&args.count("--mount")&&args.count("--volume-id")&&args.count("--storage-generation")&&args.count("--run-id")&&args.count("--report"),"storage_probe_invalid_arguments");
  Require(std::regex_match(args.at("--run-id"),std::regex("[A-Za-z0-9][A-Za-z0-9_-]{7,63}")),"storage_probe_invalid_run_id");
  report=args.at("--report");NewReport(report);report_valid=true;
  phase="reserve_fresh_fixture";const fs::path mount=args.at("--mount");
  Require(mount.is_absolute()&&fs::canonical(mount)==mount&&
    (mount.string().rfind("/mnt/",0)==0||mount.string().rfind("/media/",0)==0||mount.string().rfind("/run/media/",0)==0),"storage_probe_not_external_mount_path");
  Fd mount_fd(open(mount.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));Require(mount_fd.fd>=0,"storage_probe_mount_unavailable");
  struct stat system{};Require(stat("/",&system)==0,"storage_probe_system_stat_failed");const auto mounted=Stat(mount_fd.fd);
  struct statfs filesystem{};Require(fstatfs(mount_fd.fd,&filesystem)==0&&mounted.st_dev!=system.st_dev&&filesystem.f_type!=0x01021994&&filesystem.f_type!=0x858458f6,
    "storage_probe_system_or_temporary_storage_forbidden");
  // This early guard only prevents reserving a test folder on system/tmp disks.
  // Full UUID/mount/filesystem/generation authority remains OpenProduction.
  bool created_parent=mkdirat(mount_fd.fd,"ainvr-tests",0700)==0;
  Require(created_parent||errno==EEXIST,"storage_probe_test_parent_create_failed");
  Fd parent(openat(mount_fd.fd,"ainvr-tests",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));Require(parent.fd>=0,"storage_probe_test_parent_unavailable");
  const auto parent_identity=Stat(parent.fd);Require(parent_identity.st_dev==mounted.st_dev&&SameDirectory(parent_identity,parent_identity),"storage_probe_test_parent_not_private");
  const auto basename="search-index-"+args.at("--run-id");fixture=mount/"ainvr-tests"/basename;
  Require(mkdirat(parent.fd,basename.c_str(),0700)==0,"storage_probe_target_already_exists_or_unavailable");Sync(parent.fd);
  Fd target(openat(parent.fd,basename.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));Require(target.fd>=0,"storage_probe_fixture_open_failed");
  const auto target_identity=Stat(target.fd);Require(target_identity.st_dev==mounted.st_dev&&SameDirectory(target_identity,target_identity),"storage_probe_fixture_not_private");
  const IndexStorageAuthorization authorization{args.at("--volume-id"),"ainvr-tests/"+basename,fixture.string(),args.at("--storage-generation")};
  auto deadline=[&]{Require(std::chrono::steady_clock::now()-start<std::chrono::seconds(30),"storage_probe_deadline_exceeded");};
  IndexShardFileLimits tiny;tiny.max_total_bytes=1024;tiny.max_shard_bytes=1024;tiny.max_temporary_bytes=1024;tiny.max_files=8;tiny.max_records=3;
  phase="production_authorization_and_quota";auto store=IndexShardFiles::OpenProduction(authorization,tiny);deadline();
  IndexShardIdentity id{"11111111-1111-4111-8111-111111111111",1,"22222222-2222-4222-8222-222222222222","storage-interface-fixture","1970-01-02",3,3,authorization.generation};
  std::string quota_error;try{store->Publish(id,Records(id));}catch(const std::runtime_error& error){quota_error=error.what();}
  Require(quota_error=="search_index_file_quota"||quota_error=="search_index_byte_capacity", "storage_probe_quota_not_enforced");
  Require(Names(target.fd)==std::set<std::string>{".owner.json",".writer.lock"},"storage_probe_quota_left_artifacts");store.reset();
  IndexShardFileLimits limits;limits.max_total_bytes=16384;limits.max_shard_bytes=4096;limits.max_temporary_bytes=16384;limits.max_files=8;limits.max_records=3;
  phase="publish_and_restart";store=IndexShardFiles::OpenProduction(authorization,limits);const auto first=store->Publish(id,Records(id));
  const auto retry=store->Publish(id,Records(id));Require(first.manifest_sha256==retry.manifest_sha256&&first.byte_count==retry.byte_count,"storage_probe_atomic_retry_changed");
  auto rows=store->Load(id,first);Require(rows.size()==3&&std::abs(rows[1].vector[1]-.6f)<1e-6f,"storage_probe_roundtrip_mismatch");store.reset();
  store=IndexShardFiles::OpenProduction(authorization,limits);Require(store->Load(id,first).size()==3,"storage_probe_restart_restore_failed");
  auto second_id=id;second_id.revision=2;const auto second=store->Publish(second_id,Records(second_id));deadline();
  phase="corrupt_own_data";Fd shard(openat(target.fd,id.id.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));Require(shard.fd>=0,"storage_probe_fixture_shard_missing");
  Fd data(openat(shard.fd,"1.records.f32le",O_RDWR|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));Require(data.fd>=0,"storage_probe_fixture_data_missing");Regular(data.fd,target_identity.st_dev,4096);
  const auto data_size=Stat(data.fd).st_size;Require(data_size>24,"storage_probe_fixture_data_too_small");unsigned char byte=0;
  Require(pread(data.fd,&byte,1,data_size-1)==1,"storage_probe_corrupt_read_failed");byte^=1;
  Require(pwrite(data.fd,&byte,1,data_size-1)==1,"storage_probe_corrupt_write_failed");Sync(data.fd);
  close(data.fd);data.fd=-1;close(shard.fd);shard.fd=-1;
  bool rejected=false;try{store->Load(id,first);}catch(const std::runtime_error& error){rejected=std::string(error.what())=="search_index_data_hash_mismatch";}
  Require(rejected,"storage_probe_corruption_not_hash_rejected");Require(store->Load(second_id,second).size()==3,"storage_probe_corruption_crossed_revision");deadline();
  phase="exact_fixture_cleanup";
  // Explicit self-fixture-owner authorization only; this does not simulate a
  // PG retirement transaction or grant authority over any production object.
  store->DeleteAuthorized(id,first);store->DeleteAuthorized(id,first);Require(store->Load(second_id,second).size()==3,"storage_probe_exact_cleanup_removed_other_revision");
  store->DeleteAuthorized(second_id,second);store.reset();
  CleanupFixture(mount_fd.fd,parent.fd,target.fd,basename,authorization.volume_id,parent_identity,target_identity,created_parent);deadline();
  WriteReport(report,{{"passed",true},{"storage_interface_only",true},{"accuracy_validated",false},{"pg_transaction_validated",false},{"model_inference_executed",false},
   {"synthetic_vector_dimensions",3},{"volume_id",authorization.volume_id},{"relative_path",authorization.relative_path},{"resolved_path",authorization.resolved_path},
   {"storage_generation",authorization.generation},{"quota_rejected",true},{"quota_error",quota_error},{"atomic_retry",true},{"restart_restored",true},
   {"corrupt_hash_rejected",true},{"fixture_removed",true},{"max_total_bytes",limits.max_total_bytes},{"max_files",limits.max_files},
   {"elapsed_ms",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()}});
  std::cout<<Json({{"passed",true},{"storage_interface_only",true},{"accuracy_validated",false},{"report",report.string()}}).dump()<<'\n';return 0;
 }catch(const std::exception& error){
  const std::string raw=error.what();const auto code=raw.rfind("storage_probe_",0)==0||raw.rfind("search_index_",0)==0?raw:"storage_probe_failed";
  if(report_valid)try{WriteReport(report,{{"passed",false},{"storage_interface_only",true},{"accuracy_validated",false},{"pg_transaction_validated",false},
    {"phase",phase},{"error_code",code},{"fixture_retained_for_inspection",fixture.string()}});}catch(...){}
  std::cerr<<code<<"; phase="<<phase<<"; fixture left for inspection: "<<fixture.string()<<'\n';return 1;
 }
}

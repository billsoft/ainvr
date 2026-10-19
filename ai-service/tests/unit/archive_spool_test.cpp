#include <future>
#include <chrono>
// Copyright AINVR.
#include "output/archive_spool.hpp"
#include <bson/bson.h>
#include <gtest/gtest.h>
#include <filesystem>
#include <fstream>
#include <csignal>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
namespace {
constexpr const char* first="507f1f77bcf86cd799439011";
constexpr const char* second="507f1f77bcf86cd799439012";
struct Directory {
  std::string path;
  Directory(){char pattern[]="/home/sunrise/ainvr/test/runtime/archive-spool-XXXXXX";auto* p=mkdtemp(pattern);if(!p)throw std::runtime_error("mkdtemp failed");path=p;}
  ~Directory(){std::error_code e;std::filesystem::remove_all(path,e);}
};
std::vector<uint8_t> Record(const char* id,int value=1){
  bson_t b;bson_init(&b);bson_oid_t oid;bson_oid_init_from_string(&oid,id);BSON_APPEND_OID(&b,"_id",&oid);BSON_APPEND_UTF8(&b,"image_id",id);BSON_APPEND_INT32(&b,"value",value);
  auto p=bson_get_data(&b);std::vector<uint8_t> bytes(p,p+b.len);bson_destroy(&b);return bytes;
}
TEST(ArchiveSpool,RetainsFailedDeliveryAndRecovers){
  Directory dir;auto bytes=Record(first);
  {ainvr::ArchiveSpool spool(dir.path,4096,2);spool.Stage(first,bytes);spool.Stage(first,bytes);
   EXPECT_EQ(spool.Pending().size(),1u);EXPECT_THROW(spool.Stage(first,Record(first,2)),std::invalid_argument);
   EXPECT_THROW(spool.Deliver(first,[](const auto&){throw std::runtime_error("database unavailable");}),std::runtime_error);}
  {ainvr::ArchiveSpool spool(dir.path,4096,2);ASSERT_EQ(spool.Pending(),std::vector<std::string>{first});
   spool.Deliver(first,[&](const auto& got){EXPECT_EQ(got,bytes);});EXPECT_TRUE(spool.Pending().empty());}
  ainvr::ArchiveSpool empty(dir.path,4096,2);EXPECT_TRUE(empty.Pending().empty());
}
TEST(ArchiveSpool,CapacityNeverEvictsPendingRecords){
  Directory dir;auto bytes=Record(first);ainvr::ArchiveSpool spool(dir.path,bytes.size()+40,10);spool.Stage(first,bytes);
  EXPECT_THROW(spool.Stage(second,Record(second)),std::runtime_error);EXPECT_EQ(spool.Pending(),std::vector<std::string>{first});
  spool.Deliver(first,[](const auto&){});spool.Stage(second,Record(second));EXPECT_EQ(spool.Pending(),std::vector<std::string>{second});
}
TEST(ArchiveSpool,ExclusiveOwnerAndRecordLimit){
  Directory dir;ainvr::ArchiveSpool spool(dir.path,4096,1);EXPECT_THROW((ainvr::ArchiveSpool(dir.path,4096,1)),std::runtime_error);
  spool.Stage(first,Record(first));EXPECT_THROW(spool.Stage(second,Record(second)),std::runtime_error);
}
TEST(ArchiveSpool,CorruptionIsRetainedAndRejected){
  Directory dir;{ainvr::ArchiveSpool spool(dir.path,4096,2);spool.Stage(first,Record(first));}
  auto path=std::filesystem::path(dir.path)/(std::string(first)+".pending");
  {std::fstream file(path,std::ios::binary|std::ios::in|std::ios::out);file.seekg(8);char bad=0;file.read(&bad,1);bad^=1;file.seekp(8);file.write(&bad,1);}
  EXPECT_THROW((ainvr::ArchiveSpool(dir.path,4096,2)),std::runtime_error);EXPECT_TRUE(std::filesystem::exists(path));
}
TEST(ArchiveSpool,RejectsPathAndIdentityMismatch){
  Directory dir;ainvr::ArchiveSpool spool(dir.path,4096,2);
  EXPECT_THROW(spool.Stage("../outside",Record(first)),std::invalid_argument);
  EXPECT_THROW(spool.Stage(second,Record(first)),std::invalid_argument);EXPECT_TRUE(spool.Pending().empty());
}
TEST(ArchiveSpool,SurvivesKilledWriterAfterStageAcknowledgement){
  Directory dir;int signal_pipe[2];ASSERT_EQ(pipe(signal_pipe),0);
  pid_t child=fork();ASSERT_GE(child,0);
  if(child==0){close(signal_pipe[0]);try{ainvr::ArchiveSpool spool(dir.path,4096,2);spool.Stage(first,Record(first));char ready=1;if(write(signal_pipe[1],&ready,1)!=1)_exit(3);for(;;)pause();}catch(...){_exit(2);}}
  close(signal_pipe[1]);char ready=0;pollfd event{signal_pipe[0],POLLIN,0};auto n=poll(&event,1,5000)>0?read(signal_pipe[0],&ready,1):-1;close(signal_pipe[0]);kill(child,SIGKILL);int status;waitpid(child,&status,0);
  ASSERT_EQ(n,1);ASSERT_EQ(ready,1);ASSERT_TRUE(WIFSIGNALED(status));
  ainvr::ArchiveSpool recovered(dir.path,4096,2);ASSERT_EQ(recovered.Pending(),std::vector<std::string>{first});
  recovered.Deliver(first,[](const auto& got){EXPECT_EQ(got,Record(first));});
}
}

TEST(ArchiveSpoolConcurrency,ProducerDoesNotWaitForDatabase) {
 Directory dir;ainvr::ArchiveSpool spool(dir.path,8192,3);
 spool.Stage(first,Record(first));
 std::promise<void> entered,release;
 auto wait_release=release.get_future().share();
 auto consumer=std::async(std::launch::async,[&]{
   spool.Deliver(first,[&](const auto&){entered.set_value();wait_release.wait();});
 });
 entered.get_future().wait();
 auto producer=std::async(std::launch::async,[&]{spool.Stage(second,Record(second));});
 const auto ready=producer.wait_for(std::chrono::seconds(2));
 // Always release the consumer, even if the expectation fails.
 release.set_value();
 EXPECT_EQ(ready,std::future_status::ready);
 producer.get();consumer.get();
 EXPECT_EQ(spool.Pending(),std::vector<std::string>{second});
}

// Copyright AINVR. Exercise the reused watchdog, without touching live services.
#include "utils/systemd_watchdog.hpp"
#include <gtest/gtest.h>
#include <poll.h>
#include <atomic>
#include <map>
#include <optional>

namespace {
struct Environment {
  std::map<std::string,std::optional<std::string>> old;
  Environment(){for(const auto key:{"NOTIFY_SOCKET","WATCHDOG_USEC","WATCHDOG_PID"}){
    const auto value=std::getenv(key);old[key]=value?std::optional<std::string>(value):std::nullopt;}}
  ~Environment(){for(const auto& [key,value]:old){if(value)setenv(key.c_str(),value->c_str(),1);else unsetenv(key.c_str());}}
};
struct Receiver {
  int fd=socket(AF_UNIX,SOCK_DGRAM|SOCK_CLOEXEC,0);
  std::string name="@ainvr-watchdog-test-"+std::to_string(getpid());
  Receiver(){
    if(fd<0)throw std::runtime_error("Cannot open notification receiver");
    sockaddr_un address{};address.sun_family=AF_UNIX;
    std::memcpy(address.sun_path,name.data(),name.size());address.sun_path[0]=0;
    if(bind(fd,reinterpret_cast<sockaddr*>(&address),offsetof(sockaddr_un,sun_path)+name.size()))
      throw std::runtime_error("Cannot bind abstract test notification receiver");
    setenv("NOTIFY_SOCKET",name.c_str(),1);setenv("WATCHDOG_USEC","30000",1);unsetenv("WATCHDOG_PID");
  }
  ~Receiver(){if(fd>=0)close(fd);}
  std::string Get(int milliseconds=500){pollfd p{fd,POLLIN,0};if(poll(&p,1,milliseconds)<=0)return {};
    char data[512];const auto n=recv(fd,data,sizeof(data),0);return n>0?std::string(data,n):std::string{};}
};
}
TEST(SystemdWatchdog,OnlyResponsiveControlPlaneReceivesHeartbeats){
  Environment env;Receiver receiver;std::atomic<bool> alive=false;
  ai_service::utils::SystemdWatchdog watchdog([&]{return alive.load();});
  auto message=receiver.Get();ASSERT_NE(message.find("unresponsive"),std::string::npos);
  EXPECT_EQ(message.find("WATCHDOG=1"),std::string::npos);
  alive=true;bool heartbeat=false;
  for(int i=0;i<10&&!heartbeat;++i)heartbeat=receiver.Get().find("WATCHDOG=1")!=std::string::npos;
  EXPECT_TRUE(heartbeat);alive=false;
  bool unresponsive=false;
  for(int i=0;i<10&&!unresponsive;++i)unresponsive=receiver.Get().find("unresponsive")!=std::string::npos;
  ASSERT_TRUE(unresponsive);for(int i=0;i<3;++i)EXPECT_EQ(receiver.Get().find("WATCHDOG=1"),std::string::npos);
  watchdog.Stop();while(!receiver.Get(0).empty()){}EXPECT_TRUE(receiver.Get(30).empty());
}
TEST(SystemdWatchdog,WrongPidAndInvalidDurationDoNotSendFakeHeartbeats){
  Environment env;Receiver receiver;const auto other=std::to_string(getpid()+1);setenv("WATCHDOG_PID",other.c_str(),1);
  {ai_service::utils::SystemdWatchdog watchdog([]{return true;});EXPECT_TRUE(receiver.Get(50).empty());}
  unsetenv("WATCHDOG_PID");setenv("WATCHDOG_USEC","invalid",1);
  {ai_service::utils::SystemdWatchdog watchdog([]{return true;});EXPECT_TRUE(receiver.Get(50).empty());}
}
TEST(SystemdWatchdog,StopInterruptsLongNotificationWait){
  Environment env;Receiver receiver;setenv("WATCHDOG_USEC","30000000",1);
  ai_service::utils::SystemdWatchdog watchdog([]{return true;});ASSERT_FALSE(receiver.Get().empty());
  const auto before=std::chrono::steady_clock::now();watchdog.Stop();
  const double elapsed_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-before).count();
  EXPECT_LT(elapsed_ms,100);
}

// 诊断日志不能把调用方（常常持有授权全局锁）拖进 I/O：输出端卡住时，LicenseDiagnostic 必须立刻返回。
#include <gtest/gtest.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "diagnostics.hpp"
#include "license_manager.hpp"
#include "encoding.hpp"
#include "test_issuer.hpp"
#include <filesystem>
using namespace ainvr_license;
using namespace std::chrono_literals;
namespace {
struct Gate {
  std::atomic<bool> entered{false};std::mutex mu;std::condition_variable cv;bool open=true;std::vector<std::string> lines;
  void Wait(){std::unique_lock lk(mu);cv.wait(lk,[&]{return open;});}
  void Set(bool v){{std::lock_guard lk(mu);open=v;}cv.notify_all();}
  size_t Size(){std::lock_guard lk(mu);return lines.size();}
};
struct SinkScope {
  Gate g;
  SinkScope(){
    // Earlier fixtures can leave asynchronous messages in the global queue.
    // Drain them before capturing this test's exact message count.
    FlushDiagnostics();
    SetDiagnosticSink([this](const std::string&l){g.entered=true;g.Wait();std::lock_guard lk(g.mu);g.lines.push_back(l);});
  }
  ~SinkScope(){g.Set(true);FlushDiagnostics();SetDiagnosticSink(nullptr);}
};
}
TEST(LicenseDiagnostics,CallerNeverWaitsForABlockedOutput){
  SinkScope s;s.g.Set(false);                      // 输出端卡住（等价于 journald/磁盘停顿）
  auto t0=std::chrono::steady_clock::now();
  for(int i=0;i<50;++i)LicenseDiagnostic({{"event","x"},{"i",i}});
  EXPECT_LT(std::chrono::steady_clock::now()-t0,200ms);
  s.g.Set(true);FlushDiagnostics();
  EXPECT_EQ(s.g.Size(),50u);
}
TEST(LicenseDiagnostics,LinesAreDeliveredInOrderWithComponentTag){
  SinkScope s;
  for(int i=0;i<5;++i)LicenseDiagnostic({{"i",i}});
  FlushDiagnostics();
  ASSERT_EQ(s.g.Size(),5u);
  for(int i=0;i<5;++i){auto j=nlohmann::json::parse(s.g.lines[i]);EXPECT_EQ(j["i"],i);EXPECT_EQ(j["component"],"license");}
}
TEST(LicenseDiagnostics,OverflowDropsOldestAndReportsHowManyWereDropped){
  SinkScope s;s.g.Set(false);
  LicenseDiagnostic({{"i",0}});                    // 这一条被写出线程取走并卡在输出端里
  while(!s.g.entered)std::this_thread::sleep_for(1ms);
  for(int i=1;i<DiagnosticQueueLimit()+100;++i)LicenseDiagnostic({{"i",i}});
  auto t0=std::chrono::steady_clock::now();
  LicenseDiagnostic({{"i",-1}});                   // 队列已满也不阻塞
  EXPECT_LT(std::chrono::steady_clock::now()-t0,100ms);
  s.g.Set(true);FlushDiagnostics();
  bool saw_drop_notice=false,saw_newest=false,saw_oldest=false;
  for(auto&l:s.g.lines){auto j=nlohmann::json::parse(l);
    if(j.value("event","")=="diagnostics_dropped"){saw_drop_notice=true;EXPECT_GE(j["dropped"].get<int>(),100);}
    if(j.value("i",0)==-1)saw_newest=true;
    if(j.contains("i")&&j["i"]==1)saw_oldest=true;}   // 队列里最旧的一条应已被丢弃
  EXPECT_TRUE(saw_drop_notice);EXPECT_TRUE(saw_newest);EXPECT_FALSE(saw_oldest);
}
TEST(LicenseDiagnostics,ThrowingSinkNeverEscapes){
  SetDiagnosticSink([](const std::string&){throw std::runtime_error("disk gone");});
  EXPECT_NO_THROW(LicenseDiagnostic({{"event","x"}}));
  EXPECT_NO_THROW(FlushDiagnostics());
  SetDiagnosticSink(nullptr);
}

namespace {
struct SamplingClock : FakeClock {
  bool fail_boot=false;
  SamplingClock():FakeClock(1800000000,1000000000,"sampling-boot"){}
  int64_t BootNs()override{if(fail_boot)throw std::runtime_error("BOOT_READ_FAILED");return FakeClock::BootNs();}
};
struct SamplingRig {
  TestIssuer issuer;
  std::filesystem::path dir=std::filesystem::temp_directory_path()/("license-sampling-"+HexEncode(RandomBytes(8)));
  Key32 key{}; SamplingClock clock; MachineInfo machine;
  std::shared_ptr<StateStore> store; std::unique_ptr<LicenseManager> mgr;
  SamplingRig(){
    std::filesystem::create_directories(dir);
    machine.code="0123456789ABCDEFGHJKMNPQ";machine.code_grouped=GroupCode(machine.code);machine.chip_uid="sampling-board";
    store=std::make_shared<StateStore>(std::vector<std::string>{(dir/"primary").string()},key,machine.chip_uid,machine.code);
    store->EnableV3((dir/"identity").string(),issuer.keys);
    Restart();
    EXPECT_FALSE(mgr->Activate(issuer.Token(machine.code,store->InstallationId(),10,1)));
  }
  void Restart(){mgr=std::make_unique<LicenseManager>(machine,store,&clock);mgr->Init();mgr->SetSignalKeys({{"recorder",key}});}
  nlohmann::json Read(){std::string body,error;mgr->BuildSignedStatus("recorder",std::string(32,'a'),body,error);EXPECT_TRUE(error.empty());
    return nlohmann::json::parse(B64UrlDecode(nlohmann::json::parse(body)["payload"].get<std::string>()).value());}
  ~SamplingRig(){mgr.reset();store.reset();std::filesystem::remove_all(dir);}
};
}
TEST(LicenseClockSnapshot,RegressionCapturesTheRejectedSample){
  SamplingRig r;r.Read();r.clock.SetMono(500000000);r.clock.SetWall(1800000007);
  auto p=r.Read();auto d=p["diagnostics"];
  EXPECT_EQ(p["state"],"clock_error");EXPECT_EQ(d["mono_ns"],500000000);EXPECT_EQ(d["boot_ns"],500000000);
  EXPECT_EQ(d["wall_sec"],1800000007);EXPECT_EQ(d["previous_mono_ns"],1000000000);
  EXPECT_EQ(d["calculation_error"],"CLOCK_REGRESSION");EXPECT_EQ(d["sampling_complete"],true);
}
TEST(LicenseClockSnapshot,ReadFailureDoesNotReuseOldClockValues){
  SamplingRig r;r.Read();r.clock.AdvanceNormal(5);r.clock.fail_boot=true;
  auto p=r.Read();auto d=p["diagnostics"];
  EXPECT_EQ(p["state"],"clock_error");EXPECT_EQ(d["mono_ns"],6000000000);
  EXPECT_TRUE(d.contains("boot_ns")&&d["boot_ns"].is_null());
  EXPECT_EQ(d["sampling_complete"],false);EXPECT_EQ(d["sampling_field"],"boot_ns");
  EXPECT_EQ(d["calculation_error"],"BOOT_READ_FAILED");
}
TEST(LicenseClockSnapshot,StartupRegressionCapturesTheRejectedSample){
  SamplingRig r;r.clock.SetMono(0);r.clock.SetWall(1800000010);r.Restart();
  auto p=r.Read();auto d=p["diagnostics"];
  EXPECT_EQ(p["state"],"clock_error");EXPECT_EQ(d["mono_ns"],0);EXPECT_EQ(d["wall_sec"],1800000010);
  EXPECT_EQ(d["startup"],true);EXPECT_EQ(d["calculation_error"],"CLOCK_REGRESSION");
}

#include <gtest/gtest.h>
#include <filesystem>
#include <fstream>
#include <unistd.h>
#include <nlohmann/json.hpp>
#include "license_manager.hpp"
#include "license_http_app.hpp"
#include "encoding.hpp"
#include "license_budget.hpp"
#include "test_issuer.hpp"
#include "uds_server.hpp"
#include <sys/socket.h>
#include <sys/un.h>
#include <cstring>
using namespace ainvr_license;
// 预算参数来自 license_budget.hpp；下面的时间都由它推出，改参数时测试不用手算。
constexpr int kQ=kBudgetReservationSec,kL=kMaxLeaseSec,kA=kBudgetAheadSec;
constexpr int kRenewAfter=kQ-kL-kA+10;   // 已用时间超过它，已落盘预算剩余就不足 L+A，必须续期
namespace {
struct Rig {
  TestIssuer issuer;
  std::filesystem::path dir;
  Key32 key{};
  MachineInfo machine;
  FakeClock clock{1800000000,1000000000,"test-boot"};
  std::shared_ptr<StateStore>store;
  std::unique_ptr<LicenseManager>mgr;
  Rig(){
    dir=std::filesystem::temp_directory_path()/("license-v2-test-"+HexEncode(RandomBytes(8)));
    std::filesystem::create_directories(dir);
    machine.code="0123456789ABCDEFGHJKMNPQ";machine.code_grouped=GroupCode(machine.code);machine.chip_uid="synthetic-board";
    store=std::make_shared<StateStore>(std::vector<std::string>{(dir/"primary").string(),(dir/"copy1").string()},key,machine.chip_uid,machine.code);
    store->EnableV3((dir/"identity").string(),issuer.keys);
    mgr=std::make_unique<LicenseManager>(machine,store,&clock);mgr->Init();
  }
  ~Rig(){mgr.reset();store.reset();std::filesystem::remove_all(dir);}
  std::string Token(int minutes=10,int seq=1){return issuer.Token(machine.code,store->InstallationId(),minutes,seq);}
  void Activate(int minutes=10){ASSERT_FALSE(mgr->Activate(Token(minutes)));}
};
TEST(HybridV2,FrozenAndBackwardWallStillExpire){Rig r;r.Activate(1);for(int i=0;i<61;++i){r.clock.AdvanceMonoSec(1);r.clock.AdvanceWall(-2);r.mgr->Tick();}EXPECT_EQ(r.mgr->status().state,LicenseState::kExpired);}
TEST(HybridV2,ForwardJumpIsChargedOnce){Rig r;r.Activate();r.clock.AdvanceMonoSec(10);r.clock.AdvanceWall(100);EXPECT_EQ(r.mgr->status().used_seconds,100);r.clock.AdvanceMonoSec(10);EXPECT_EQ(r.mgr->status().used_seconds,110);r.clock.AdvanceWall(-1000);r.clock.AdvanceMonoSec(10);EXPECT_EQ(r.mgr->status().used_seconds,120);}
TEST(HybridV2,SubsecondTimeAndSuspendCount){Rig r;r.Activate();for(int i=0;i<100;++i){r.clock.AdvanceNs(10000000);r.mgr->Tick();}EXPECT_EQ(r.mgr->status().used_seconds,1);r.clock.Suspend(20);EXPECT_EQ(r.mgr->status().used_seconds,21);}
TEST(ActivationV2,StartsAtActivationNotIssue){Rig r;r.Activate(1);EXPECT_EQ(r.mgr->status().remaining_seconds,60);}
TEST(ActivationClock,UncalibratedClockDoesNotConsumeGrant) {
  Rig r;
  auto token=r.issuer.Token(r.machine.code,r.store->InstallationId(),60,1,1800000000);
  r.clock.SetWall(0);
  LicensePayload preview;
  EXPECT_TRUE(r.mgr->Preview(token,preview));
  EXPECT_TRUE(r.mgr->Activate(token));
  EXPECT_EQ(r.store->GrantFloor(),0);
  EXPECT_FALSE(std::filesystem::exists(r.dir/"primary"));
  r.clock.SetWall(1800000000);
  EXPECT_FALSE(r.mgr->Activate(token));
  EXPECT_EQ(r.mgr->status().remaining_seconds,3600);
}
TEST(ActivationClock,SmallIssuerSkewDoesNotShortenGrantOnCorrection) {
  Rig r;
  auto token=r.issuer.Token(r.machine.code,r.store->InstallationId(),60,1,1800000000);
  r.clock.SetWall(1799999940);
  ASSERT_FALSE(r.mgr->Activate(token));
  r.clock.SetWall(1800000000);
  EXPECT_EQ(r.mgr->status().remaining_seconds,3600);
}
TEST(UdsRecovery,TemporaryAcceptExhaustionDoesNotLoseWorkers) {
  Rig r;LicenseHttpApp app(r.mgr.get(),std::string(32,'k'));
  std::atomic<int> attempts{0};auto path=(r.dir/"socket").string();
  UdsServer server(path,&app,[&](int fd){
    if(attempts.fetch_add(1)<8){errno=EMFILE;return -1;}
    return accept4(fd,nullptr,nullptr,SOCK_CLOEXEC|SOCK_NONBLOCK);
  });
  ASSERT_TRUE(server.Start());
  int fd=socket(AF_UNIX,SOCK_STREAM,0);ASSERT_GE(fd,0);
  sockaddr_un addr{};addr.sun_family=AF_UNIX;std::strcpy(addr.sun_path,path.c_str());
  ASSERT_EQ(connect(fd,reinterpret_cast<sockaddr*>(&addr),sizeof(addr)),0);
  timeval timeout{3,0};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
  std::string request="GET /healthz HTTP/1.1\r\nHost: local\r\n\r\n";
  send(fd,request.data(),request.size(),MSG_NOSIGNAL);
  char response[2048];auto n=recv(fd,response,sizeof(response),0);close(fd);
  ASSERT_GT(n,0);EXPECT_NE(std::string(response,n).find("200"),std::string::npos);
  EXPECT_FALSE(server.Failed());server.Stop();
}
TEST(ActivationV2,RepeatedKeyIsIdempotentEvenAfterExpiry){Rig r;auto token=r.Token(1);ASSERT_FALSE(r.mgr->Activate(token));r.clock.AdvanceNormal(70);EXPECT_EQ(r.mgr->status().state,LicenseState::kExpired);ASSERT_FALSE(r.mgr->Activate(token));EXPECT_EQ(r.mgr->status().state,LicenseState::kExpired);}
TEST(ActivationV2,NewGrantReplacesAndOldGrantCannotDowngrade){Rig r;auto old=r.Token();ASSERT_FALSE(r.mgr->Activate(old));r.clock.AdvanceNormal(90);ASSERT_FALSE(r.mgr->Activate(r.Token(20,2)));EXPECT_EQ(r.mgr->status().remaining_seconds,1200);EXPECT_TRUE(r.mgr->Activate(old));}
TEST(ActivationV2,SaveFailureCannotGrant){Rig r;std::filesystem::create_directory(r.dir/"primary");EXPECT_TRUE(r.mgr->Activate(r.Token()));EXPECT_EQ(r.mgr->status().state,LicenseState::kStorageError);}
TEST(RecoveryV2,CrashChargesReservedBudget){Rig r;r.Activate();r.clock.AdvanceMonoSec(10);r.mgr->Tick();r.mgr=std::make_unique<LicenseManager>(r.machine,r.store,&r.clock);r.mgr->Init();EXPECT_GE(r.mgr->status().used_seconds,60);}
TEST(RecoveryV2,PrimaryIsAuthorityAndCopiesMayLag){Rig r;r.Activate();auto first=r.store->Load().record.value();r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();r.mgr->Flush();auto current=r.store->Load().record.value();EXPECT_GT(current.seq,first.seq);std::filesystem::remove(r.dir/"copy1");EXPECT_FALSE(r.store->Load().tampered);std::filesystem::remove(r.dir/"primary");std::ofstream(r.dir/"copy1")<<"{}";EXPECT_TRUE(r.store->Load().tampered);}
TEST(RecoveryV2,InvalidStateDoesNotBecomeFreshInstall){Rig r;std::ofstream(r.dir/"primary")<<"{\"data\":{},\"sig\":42}";auto result=r.store->Load();EXPECT_TRUE(result.tampered);EXPECT_FALSE(result.record);}
TEST(LeaseV2,AuthenticatedBindingAndBoundedBudget){Rig r;r.Activate();r.mgr->SetSignalKeys({{"recorder",r.key}});std::string body,error,nonce(32,'a');r.mgr->BuildSignedStatus("recorder",nonce,body,error);ASSERT_TRUE(error.empty());auto env=nlohmann::json::parse(body);auto encoded=env["payload"].get<std::string>();EXPECT_EQ(env["sig"],HmacSha256Hex(r.key,"AINVR/lease/v2|"+encoded));auto raw=B64UrlDecode(encoded).value();auto p=nlohmann::json::parse(raw);EXPECT_EQ(p["device_id"],r.machine.code);EXPECT_EQ(p["audience"],"recorder");EXPECT_EQ(p["nonce"],nonce);EXPECT_LE(p["lease_ms"].get<int>(),30000);r.clock.AdvanceNormal(599);r.mgr->BuildSignedStatus("recorder",nonce,body,error);env=nlohmann::json::parse(body);raw=B64UrlDecode(env["payload"].get<std::string>()).value();p=nlohmann::json::parse(raw);EXPECT_LE(p["lease_ms"].get<int>(),1000);}
TEST(HttpV2,PreviewDoesNotConsumeAndRetryReportsAlreadyActive){Rig r;LicenseHttpApp app(r.mgr.get(),std::string(32,'k'));auto key=r.Token();WebRequest request{"POST","/api/v1/license/preview",nlohmann::json{{"key",key}}.dump(),{{"x-api-key",std::string(32,'k')}}};EXPECT_EQ(app.Dispatch(request).status,200);EXPECT_EQ(r.mgr->status().state,LicenseState::kUnlicensed);request.target="/api/v1/license/activate";EXPECT_EQ(app.Dispatch(request).status,200);auto second=nlohmann::json::parse(app.Dispatch(request).body);EXPECT_EQ(second["activation_result"],"already_active");}
TEST(SignedCodec,RejectsBadNumericBoundsAndSignature) {
  Rig r;
  EXPECT_THROW(r.store->VerifyGrant(r.Token(kMaxMinutes+1)),std::exception);
  EXPECT_THROW(r.store->VerifyGrant(r.Token(60,0)),std::exception);
  auto token=r.Token();token.back()=token.back()=='A'?'B':'A';
  EXPECT_THROW(r.store->VerifyGrant(token),std::exception);
}
}


TEST(RecoveryV2,NewBootCannotSubtractOldMonotonicClock) {
  Rig r;
  r.Activate();
  r.clock.AdvanceNormal(90);
  r.mgr->Tick();
  const auto before = r.mgr->status().used_seconds;
  r.clock.SetBoot("another-boot");
  r.clock.SetMono(1000000);
  r.clock.AdvanceWall(-3600);
  r.mgr = std::make_unique<LicenseManager>(r.machine, r.store, &r.clock);
  r.mgr->Init();
  EXPECT_GE(r.mgr->status().used_seconds, before);
  EXPECT_GE(r.mgr->status().used_seconds, 150);
}

TEST(RecoveryV2,ReservationFailureStopsNewLeases) {
  Rig r;
  r.Activate();
  r.mgr->SetSignalKeys({{"recorder", r.key}});
  std::filesystem::rename(r.dir/"primary", r.dir/"saved");
  std::filesystem::create_directory(r.dir/"primary");
  r.clock.AdvanceNormal(kRenewAfter);
  std::string body, error;
  r.mgr->BuildSignedStatus("recorder", std::string(32, 'a'), body, error);  // 触发后台续期落盘（会失败）
  ASSERT_TRUE(error.empty());
  r.mgr->Flush();                                                           // 落盘结果出来之后
  r.mgr->BuildSignedStatus("recorder", std::string(32, 'a'), body, error);
  ASSERT_TRUE(error.empty());
  auto envelope = nlohmann::json::parse(body);
  auto plain = B64UrlDecode(envelope["payload"].get<std::string>()).value();
  auto payload = nlohmann::json::parse(plain);
  EXPECT_EQ(payload["state"], "storage_error");
  EXPECT_EQ(payload["lease_ms"], 0);
  EXPECT_TRUE(r.mgr->Activate(r.Token(20, 2)));
}

TEST(IdentityV2,BoardBindingIgnoresDiskAndRejectsMissingSerial) {
  class Provider : public FingerprintProvider {
   public:
    std::string serial = "board-1", disk = "disk-1";
    std::string ReadChipUid() override { return serial; }
    std::string ReadNvmeSerial() override { return disk; }
    std::string ReadSocModel() override { return "synthetic"; }
  } p;
  auto salt = HexEncode(Sha256("AINVR/public-fingerprint-salt/v2"));
  auto first = BuildMachineInfo(p, salt);
  p.disk = "replacement";
  EXPECT_EQ(first.code, BuildMachineInfo(p, salt).code);
  p.serial = "board-2";
  EXPECT_NE(first.code, BuildMachineInfo(p, salt).code);
  p.serial = "";
  EXPECT_THROW(BuildMachineInfo(p, salt), std::runtime_error);
}


// ---- 落盘不在请求路径上（2026-10-01：系统盘 ext4 日志一卡，持全局锁同步落盘的授权服务答不上请求，
//      租约到期、授权执行器停掉流媒体服务；14 小时内休眠约 20 次） ----
#include <chrono>
#include <condition_variable>
#include <thread>
namespace {
// 可控的存储：能卡住 Save、让它失败、并按顺序记录每次落盘的内容
class GatedStore : public StateStore {
 public:
  struct Entry {int64_t seq;std::string license_id;bool revoked;int64_t reserved_ns;};
  using StateStore::StateStore;
  void Save(const LicenseRecord& r) const override {
    std::unique_lock<std::mutex> l(m);
    log.push_back({r.seq,r.license_id,r.revoked,r.reserved_ns});
    ++entered;cv.notify_all();
    cv.wait(l,[&]{return !closed;});
    if(fail)throw std::runtime_error("synthetic disk failure");
    l.unlock();
    StateStore::Save(r);
  }
  void Close(){std::lock_guard<std::mutex> l(m);closed=true;}
  void Open(){{std::lock_guard<std::mutex> l(m);closed=false;}cv.notify_all();}
  void Fail(bool v){std::lock_guard<std::mutex> l(m);fail=v;}
  // 轮询而不是 wait_for：GCC 11 的 ThreadSanitizer 不识别 pthread_cond_clockwait，会误报重复加锁
  bool WaitEntered(int n,int ms=3000){
    for(int i=0;i<ms/5;++i){{std::lock_guard<std::mutex> l(m);if(entered>=n)return true;}std::this_thread::sleep_for(std::chrono::milliseconds(5));}
    std::lock_guard<std::mutex> l(m);return entered>=n;
  }
  size_t Saves(){std::lock_guard<std::mutex> l(m);return log.size();}
  std::vector<Entry> Log(){std::lock_guard<std::mutex> l(m);return log;}
  mutable std::mutex m;
  mutable std::condition_variable cv;
  mutable bool closed=false,fail=false;
  mutable int entered=0;
  mutable std::vector<Entry> log;
};
struct SlowRig {
  TestIssuer issuer;
  std::filesystem::path dir;
  Key32 key{};
  MachineInfo machine;
  FakeClock clock{1800000000,1000000000,"test-boot"};
  std::shared_ptr<GatedStore> store;
  std::unique_ptr<LicenseManager> mgr;
  SlowRig(){
    dir=std::filesystem::temp_directory_path()/("license-slow-test-"+HexEncode(RandomBytes(8)));
    std::filesystem::create_directories(dir);
    machine.code="0123456789ABCDEFGHJKMNPQ";machine.code_grouped=GroupCode(machine.code);machine.chip_uid="synthetic-board";
    store=std::make_shared<GatedStore>(std::vector<std::string>{(dir/"primary").string(),(dir/"copy1").string()},key,machine.chip_uid,machine.code);
    store->EnableV3((dir/"identity").string(),issuer.keys);
    mgr=std::make_unique<LicenseManager>(machine,store,&clock);mgr->Init();
    mgr->SetSignalKeys({{"recorder",key}});
  }
  ~SlowRig(){store->Open();mgr.reset();store.reset();std::filesystem::remove_all(dir);}
  std::string Token(int minutes=10,int seq=1){return issuer.Token(machine.code,store->InstallationId(),minutes,seq);}
  // 返回 {state, lease_ms}；同时测量这次请求花了多久
  std::pair<std::string,int> Lease(double* took_ms=nullptr){
    auto t0=std::chrono::steady_clock::now();
    std::string body,error;mgr->BuildSignedStatus("recorder",std::string(32,'a'),body,error);
    if(took_ms)*took_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count();
    EXPECT_TRUE(error.empty());
    auto p=nlohmann::json::parse(B64UrlDecode(nlohmann::json::parse(body)["payload"].get<std::string>()).value());
    return {p["state"].get<std::string>(),p["lease_ms"].get<int>()};
  }
};
// 保险：测试失败也不能把自己挂死——超时后强制放开存储
struct Watchdog {
  std::thread t;std::atomic<bool> done{false};
  Watchdog(GatedStore*s,int ms=4000){t=std::thread([=]{for(int i=0;i<ms/10&&!done;++i)std::this_thread::sleep_for(std::chrono::milliseconds(10));if(!done)s->Open();});}
  ~Watchdog(){done=true;t.join();}
};
}

TEST(AsyncPersistV2,RequestsDoNotWaitForSlowPersistence){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kQ-25);                  // 已落盘预算只剩 25 秒，必须续期；这次落盘会卡住
  auto t0=std::chrono::steady_clock::now();
  r.mgr->Tick();
  double took=0;auto lease=r.Lease(&took);
  double total=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t0).count();
  EXPECT_LT(total,500.0)<<"Tick+授权请求被落盘阻塞了 "<<total<<"ms";
  EXPECT_EQ(lease.first,"valid");
  EXPECT_GT(lease.second,0);
  EXPECT_LE(lease.second,25000);                 // 只能用已落盘的预算
}

TEST(AsyncPersistV2,LeaseNeverExceedsTheDurableBudgetWhilePersistenceIsStalled){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));   // 落盘预算 kQ 秒
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kQ-35);r.mgr->Tick();
  EXPECT_EQ(r.Lease().second,30000);                    // 剩 35 秒，仍是满租约
  r.clock.AdvanceNormal(20);                            // 已落盘预算只剩 15 秒
  auto partial=r.Lease();
  EXPECT_LE(partial.second,15000);
  EXPECT_GT(partial.second,0);
  r.clock.AdvanceNormal(16);                            // 预算耗尽，授权仍有效但不能再签发租约
  EXPECT_EQ(r.Lease().second,0)<<"没落盘的预算被提前放行了";
  r.store->Open();r.mgr->Flush();                       // 落盘恢复后重新签发
  r.mgr->Tick();
  EXPECT_GT(r.Lease().second,0);
}

TEST(AsyncPersistV2,AStalledPersistOfAboutAMinuteStillKeepsTheLeaseAlive){
  // 2026-10-02 实测系统盘卡顿时授权主文件落盘最长 32.6 秒。原参数只扛 40 秒，余量过薄；
  // 现在从发起续期起，落盘卡住 kL+kA 秒以内租约都不会归零（这里取 60 秒，是原参数能力的 1.5 倍）。
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kQ-kL-kA+1);r.mgr->Tick();      // 刚过续期线：这次续期卡在落盘里
  for(int i=0;i<60;++i){r.clock.AdvanceNormal(1);r.mgr->Tick();}
  auto lease=r.Lease();
  EXPECT_EQ(lease.first,"valid");
  EXPECT_GT(lease.second,0)<<"卡 60 秒就耗尽了预算";
  r.store->Open();r.mgr->Flush();r.mgr->Tick();
  EXPECT_EQ(r.Lease().second,30000);                    // 落盘恢复后立刻回到满租约
}

TEST(AsyncPersistV2,NormalOperationKeepsFullLeasesAndPersistsAhead){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  for(int i=0;i<300;++i){r.clock.AdvanceNormal(1);r.mgr->Tick();if(i%10==0)r.mgr->Flush();EXPECT_GT(r.Lease().second,10000)<<"第 "<<i<<" 秒";}
  r.mgr->Flush();
  auto on_disk=r.store->Load().record.value();
  EXPECT_GE(on_disk.reserved_ns,on_disk.used_ns);       // 磁盘上的预算始终覆盖已用时间
}

TEST(AsyncPersistV2,ActivationWaitsForDurabilityBeforeSucceeding){
  SlowRig r;r.store->Close();Watchdog wd(r.store.get());
  std::atomic<bool> returned{false};std::optional<ActivateError> result;
  std::thread t([&]{result=r.mgr->Activate(r.Token());returned=true;});
  ASSERT_TRUE(r.store->WaitEntered(1));
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  EXPECT_FALSE(returned.load())<<"激活没等落盘就返回了";
  r.store->Open();t.join();
  EXPECT_FALSE(result.has_value());
  EXPECT_EQ(r.mgr->status().state,LicenseState::kValid);
  EXPECT_EQ(r.store->Load().record->license_id,std::string(31,'0')+"1");
}

TEST(AsyncPersistV2,OlderReservationCannotOverwriteANewerActivation){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token(10,1)));
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();ASSERT_TRUE(r.store->WaitEntered(2));   // 授权 A 的续期卡在落盘里
  std::optional<ActivateError> result;std::thread t([&]{result=r.mgr->Activate(r.Token(20,2));});
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  r.store->Open();t.join();r.mgr->Flush();
  EXPECT_FALSE(result.has_value());
  EXPECT_EQ(r.store->Load().record->license_id,std::string(31,'0')+"2");          // 最终落盘的是新授权
  auto log=r.store->Log();
  for(size_t i=1;i<log.size();++i)EXPECT_GT(log[i].seq,log[i-1].seq)<<"落盘顺序倒退";
}

TEST(AsyncPersistV2,RevocationAfterAQueuedReservationWins){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();ASSERT_TRUE(r.store->WaitEntered(2));
  std::optional<ActivateError> result;std::thread t([&]{result=r.mgr->Remove();});
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  r.store->Open();t.join();r.mgr->Flush();
  EXPECT_FALSE(result.has_value());
  EXPECT_TRUE(r.store->Load().record->revoked);                                    // 注销不会被更早的续期覆盖回去
  EXPECT_EQ(r.mgr->status().state,LicenseState::kUnlicensed);
}

TEST(AsyncPersistV2,BackgroundPersistFailureStopsLeasesAndNeedsRepair){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  r.store->Fail(true);
  r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();r.mgr->Flush();
  auto lease=r.Lease();
  EXPECT_EQ(lease.first,"storage_error");EXPECT_EQ(lease.second,0);
  EXPECT_TRUE(r.mgr->Activate(r.Token(20,2)));         // 需要修复存储，不能靠重新激活绕过
}

TEST(AsyncPersistV2,PendingReservationsAreCoalesced){
  SlowRig r;ASSERT_FALSE(r.mgr->Activate(r.Token()));
  r.store->Close();Watchdog wd(r.store.get());
  r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();ASSERT_TRUE(r.store->WaitEntered(2));
  const size_t before=r.store->Saves();
  for(int i=0;i<200;++i){r.clock.AdvanceNs(50000000);r.mgr->Tick();}               // 10 秒里 200 次 Tick
  r.store->Open();r.mgr->Flush();
  EXPECT_LE(r.store->Saves()-before,3u)<<"落盘队列没有合并，磁盘被无谓地写爆";
}

TEST(RecoveryCopiesV2,BlockedReplicaDoesNotDelayBudgetAndNewestRevocationWins){
  Rig r;
  r.mgr.reset();r.store.reset();
  struct Gate {std::mutex mu;std::condition_variable cv;bool open=false;int entered=0;};
  auto gate=std::make_shared<Gate>();
  r.store=std::make_shared<StateStore>(std::vector<std::string>{(r.dir/"primary").string(),(r.dir/"copy1").string()},r.key,r.machine.chip_uid,r.machine.code,
    [gate](const std::string& path,const std::string& value){
      std::unique_lock lk(gate->mu);++gate->entered;gate->cv.notify_all();
      gate->cv.wait_for(lk,std::chrono::seconds(5),[&]{return gate->open;});
      lk.unlock();AtomicPrivateWrite(path,value);
    });
  r.store->EnableV3((r.dir/"identity").string(),r.issuer.keys);
  r.mgr=std::make_unique<LicenseManager>(r.machine,r.store,&r.clock);r.mgr->Init();
  r.mgr->SetSignalKeys({{"recorder",r.key}});
  ASSERT_FALSE(r.mgr->Activate(r.Token()));
  {std::unique_lock lk(gate->mu);ASSERT_TRUE(gate->cv.wait_for(lk,std::chrono::seconds(2),[&]{return gate->entered>0;}));}
  r.clock.AdvanceNormal(kRenewAfter);r.mgr->Tick();r.mgr->Flush();
  std::string body,error;r.mgr->BuildSignedStatus("recorder",std::string(32,'a'),body,error);
  auto p=nlohmann::json::parse(B64UrlDecode(nlohmann::json::parse(body)["payload"].get<std::string>()).value());
  EXPECT_EQ(p["lease_ms"],30000);
  EXPECT_GE(p["diagnostics"]["durable_reserved_ns"].get<int64_t>(),(kRenewAfter+kQ-10)*1000000000LL);
  EXPECT_TRUE(p["diagnostics"].contains("wall_sec"));
  EXPECT_FALSE(p["diagnostics"].contains("token_hash"));
  ASSERT_FALSE(r.mgr->Activate(r.Token(20,2)));
  ASSERT_FALSE(r.mgr->Remove());
  auto latest=r.store->Load().record.value();EXPECT_TRUE(latest.revoked);
  {std::lock_guard lk(gate->mu);gate->open=true;}gate->cv.notify_all();
  r.store->FlushReplicas();
  std::ifstream f(r.dir/"copy1");nlohmann::json copy;f>>copy;
  EXPECT_EQ(copy["data"]["seq"],latest.seq);
  EXPECT_EQ(copy["data"]["revoked"],true);
}

TEST(RecoveryCopiesV2,ReplicaFailureDoesNotRevokeAnAcknowledgedPrimary){
  Rig r;r.mgr.reset();r.store.reset();
  r.store=std::make_shared<StateStore>(std::vector<std::string>{(r.dir/"primary").string(),(r.dir/"copy1").string()},r.key,r.machine.chip_uid,r.machine.code,
    [](const std::string&,const std::string&){throw std::runtime_error("synthetic replica failure");});
  r.store->EnableV3((r.dir/"identity").string(),r.issuer.keys);
  r.mgr=std::make_unique<LicenseManager>(r.machine,r.store,&r.clock);r.mgr->Init();
  ASSERT_FALSE(r.mgr->Activate(r.Token()));r.store->FlushReplicas();
  EXPECT_EQ(r.mgr->status().state,LicenseState::kValid);
  EXPECT_TRUE(r.store->Load().record.has_value());
  EXPECT_EQ(r.store->ReplicaSeq(),0);
}

TEST(RecoveryCopiesV2,NewGrantAfterRestartedRevocationKeepsIncreasingRevision){
  Rig r;r.Activate();ASSERT_FALSE(r.mgr->Remove());
  auto revoked=r.store->Load().record.value();
  r.mgr.reset();r.mgr=std::make_unique<LicenseManager>(r.machine,r.store,&r.clock);r.mgr->Init();
  ASSERT_FALSE(r.mgr->Activate(r.Token(20,2)));
  EXPECT_GT(r.store->Load().record->seq,revoked.seq);
  EXPECT_EQ(r.mgr->status().state,LicenseState::kValid);
}

TEST(LeaseV2,ExactActivationDeadlineSurvivesShortRenewal) {
  Rig r; r.Activate(1); r.mgr->SetSignalKeys({{"recorder",r.key}});
  auto read=[&](){std::string body,error; r.mgr->BuildSignedStatus("recorder",std::string(32,'a'),body,error); EXPECT_TRUE(error.empty());
    return nlohmann::json::parse(B64UrlDecode(nlohmann::json::parse(body)["payload"].get<std::string>()).value());};
  auto p=read(); EXPECT_EQ(p["authorization_ms"],60000); EXPECT_LE(p["lease_ms"].get<int>(),30000);
  r.clock.AdvanceNs(1250000000); p=read(); EXPECT_EQ(p["authorization_ms"],58750);
  r.clock.AdvanceNormal(60); p=read(); EXPECT_EQ(p["state"],"expired"); EXPECT_EQ(p["authorization_ms"],0);
}

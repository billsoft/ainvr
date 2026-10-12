#include <gtest/gtest.h>
#include <openssl/evp.h>
#include <filesystem>
#include <fstream>
#include "license_manager.hpp"
#include "license_http_app.hpp"
#include "encoding.hpp"
#include "config.hpp"
#include <sys/stat.h>
#include <future>
using namespace ainvr_license;
namespace {
struct V3Rig {
  std::filesystem::path dir=std::filesystem::temp_directory_path()/("license-v3-"+HexEncode(RandomBytes(8)));
  Key32 key{};
  MachineInfo machine;
  FakeClock clock{1800000000,1000000000,"v3-boot"};
  EVP_PKEY* signer=nullptr;
  VerifyKeys keys;
  std::shared_ptr<StateStore> store;
  std::unique_ptr<LicenseManager> manager;
  V3Rig() {
    std::filesystem::create_directories(dir);machine.code=std::string(24,'0');machine.code_grouped=machine.code;
    auto seed=RandomBytes(32);signer=EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519,nullptr,seed.data(),seed.size());
    std::vector<unsigned char> pub(32);size_t size=pub.size();EVP_PKEY_get_raw_public_key(signer,pub.data(),&size);
    keys={{"test",HexEncode(pub)}};Restart();
  }
  ~V3Rig(){manager.reset();store.reset();EVP_PKEY_free(signer);std::filesystem::remove_all(dir);}
  void Stop(){manager.reset();if(store)store->FlushReplicas();store.reset();}
  void Restart(std::string migration={}) {
    Stop();store=std::make_shared<StateStore>(std::vector<std::string>{(dir/"state").string(),(dir/"copy1").string(),(dir/"copy2").string()},key,"",machine.code);
    store->EnableV3((dir/"identity").string(),keys,migration);
    manager=std::make_unique<LicenseManager>(machine,store,&clock);manager->Init();
  }
  nlohmann::json Payload(int sequence=1) {
    auto r=store->RegistrationRequest();auto encoded=r["activation_request"].get<std::string>().substr(11);
    auto request=nlohmann::json::parse(*B64UrlDecode(encoded));
    return {{"v",3},{"product","AINVR"},{"policy","hybrid_local"},{"kid","test"},
      {"machine_code",machine.code},{"installation_id",store->InstallationId()},
      {"license_id",HexEncode(RandomBytes(16))},{"grant_seq",sequence},{"duration_minutes",60},
      {"issued_at",clock.WallSec()},{"purpose",request["purpose"]},{"challenge",request["challenge"]},
      {"legacy_token_hash",""},{"activation_wall",0}};
  }
  std::string Sign(const nlohmann::json& j) {
    auto text=j.dump();std::vector<unsigned char> bytes(text.begin(),text.end());auto encoded=B64UrlEncode(bytes);
    auto message="AINVR/license/v3|"+encoded;auto* ctx=EVP_MD_CTX_new();
    EXPECT_EQ(EVP_DigestSignInit(ctx,nullptr,nullptr,nullptr,signer),1);std::vector<unsigned char> sig(64);size_t n=sig.size();
    EXPECT_EQ(EVP_DigestSign(ctx,sig.data(),&n,reinterpret_cast<const unsigned char*>(message.data()),message.size()),1);
    EVP_MD_CTX_free(ctx);return "AINVR-LIC3-"+encoded+"."+B64UrlEncode(sig);
  }
  void DeleteState(){for(auto name:{"state","copy1","copy2"})std::filesystem::remove(dir/name);}
};
TEST(LicenseV3,EmptyIssuerTrustAllowsRegistrationButNeverActivation) {
  V3Rig r;auto token=r.Sign(r.Payload());auto id=r.store->InstallationId();
  r.keys.clear();r.Restart();
  EXPECT_EQ(r.manager->status().state,LicenseState::kUnlicensed);
  EXPECT_EQ(r.store->InstallationId(),id);
  EXPECT_TRUE(r.store->RegistrationRequest().at("activation_request").get<std::string>().starts_with("AINVR-REQ3-"));
  EXPECT_TRUE(r.manager->Activate(token));
  EXPECT_EQ(r.manager->status().state,LicenseState::kUnlicensed);
  EXPECT_FALSE(std::filesystem::exists(r.dir/"state"));
  r.Restart();EXPECT_EQ(r.manager->status().state,LicenseState::kUnlicensed);
}
TEST(LicenseV3,SignatureMachineInstallationAndLegacyAreChecked) {
  V3Rig r;auto p=r.Payload();auto token=r.Sign(p);
  ASSERT_FALSE(r.manager->Activate(token));
  r.clock.AdvanceNormal(20);auto used=r.manager->status().used_seconds;
  EXPECT_FALSE(r.manager->Activate(token));EXPECT_EQ(r.manager->status().used_seconds,used);
  p["duration_minutes"]=120;auto text=p.dump();std::vector<unsigned char>b(text.begin(),text.end());
  EXPECT_TRUE(r.manager->Activate("AINVR-LIC3-"+B64UrlEncode(b)+token.substr(token.find('.'))));
  p=r.Payload(2);p["machine_code"]=std::string(24,'1');EXPECT_TRUE(r.manager->Activate(r.Sign(p)));
  p=r.Payload(2);p["installation_id"]=std::string(32,'b');EXPECT_TRUE(r.manager->Activate(r.Sign(p)));
  EXPECT_TRUE(r.manager->Activate("AINVR-LIC-"+std::string(120,'A')));
}
TEST(LicenseV3,DeletingAllStateRequiresFreshRecoveryAndCannotReplayOldRecovery) {
  V3Rig r;auto normal=r.Sign(r.Payload());ASSERT_FALSE(r.manager->Activate(normal));
  r.Stop();r.DeleteState();r.Restart();EXPECT_EQ(r.manager->status().state,LicenseState::kTampered);
  EXPECT_TRUE(r.manager->Activate(normal));auto recovery=r.Sign(r.Payload(2));
  ASSERT_FALSE(r.manager->Activate(recovery));EXPECT_EQ(r.manager->status().state,LicenseState::kValid);
  EXPECT_FALSE(r.manager->Activate(recovery)); // idempotent without resetting time
  r.Stop();r.DeleteState();r.Restart();EXPECT_TRUE(r.manager->Activate(recovery));
  EXPECT_FALSE(r.manager->Activate(r.Sign(r.Payload(3))));
}
TEST(LicenseV3,DeletingIdentityAndStateChangesInstallation) {
  V3Rig r;auto old=r.Sign(r.Payload());ASSERT_FALSE(r.manager->Activate(old));
  auto id=r.store->InstallationId();r.Stop();r.DeleteState();std::filesystem::remove(r.dir/"identity");r.Restart();
  EXPECT_NE(r.store->InstallationId(),id);EXPECT_TRUE(r.manager->Activate(old));
}
TEST(LicenseV3,RevocationAndIdentityDetectOldGrantState) {
  V3Rig r;auto token=r.Sign(r.Payload());ASSERT_FALSE(r.manager->Activate(token));
  r.manager->Flush();r.store->FlushReplicas();std::filesystem::copy_file(r.dir/"state",r.dir/"old");
  ASSERT_FALSE(r.manager->Remove());EXPECT_TRUE(r.manager->Activate(token));
  r.Stop();std::filesystem::copy_file(r.dir/"old",r.dir/"state",std::filesystem::copy_options::overwrite_existing);r.Restart();
  EXPECT_EQ(r.manager->status().state,LicenseState::kTampered);
}
TEST(LicenseV3,MissingReplicaDoesNotStopValidLicense) {
  V3Rig r;ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));r.Stop();
  std::filesystem::remove(r.dir/"copy1");r.Restart();EXPECT_EQ(r.manager->status().state,LicenseState::kValid);
}
TEST(LicenseV3,CorruptIdentityRequiresRecoveryRatherThanOldCode) {
  V3Rig r;auto token=r.Sign(r.Payload());ASSERT_FALSE(r.manager->Activate(token));r.Stop();
  std::ofstream(r.dir/"identity")<<"{}";r.Restart();
  EXPECT_EQ(r.manager->status().state,LicenseState::kTampered);EXPECT_TRUE(r.manager->Activate(token));
  EXPECT_FALSE(r.manager->Activate(r.Sign(r.Payload(2))));
}
TEST(LicenseV3,UnreadableIdentityIsNotQuarantinedAsTampering) {
  V3Rig r;r.Stop();
  std::filesystem::rename(r.dir/"identity",r.dir/"identity.saved");
  std::filesystem::create_directory(r.dir/"identity");
  auto store=std::make_shared<StateStore>(std::vector<std::string>{(r.dir/"state").string()},r.key,"",r.machine.code);
  EXPECT_THROW(store->EnableV3((r.dir/"identity").string(),r.keys),std::exception);
  EXPECT_TRUE(std::filesystem::is_directory(r.dir/"identity"));
  EXPECT_TRUE(std::filesystem::exists(r.dir/"identity.saved"));
}
TEST(LicenseV3,StateIoFailureDoesNotPersistRecoveryChallenge) {
  V3Rig r;ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));r.Stop();
  std::filesystem::rename(r.dir/"state",r.dir/"state.saved");
  std::filesystem::create_directory(r.dir/"state");
  r.Restart();
  auto load=r.store->Load();EXPECT_TRUE(load.storage_error);EXPECT_FALSE(load.tampered);
  EXPECT_EQ(r.manager->status().state,LicenseState::kStorageError);
  EXPECT_EQ(r.store->RegistrationRequest().at("request_kind"),"activate");
  r.Stop();std::filesystem::remove(r.dir/"state");
  std::filesystem::rename(r.dir/"state.saved",r.dir/"state");r.Restart();
  EXPECT_EQ(r.manager->status().state,LicenseState::kValid);
}
TEST(LicenseV3,RecoveryWriteFailurePreservesTamperDecisionNotClockError) {
  V3Rig r;ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));
  r.manager.reset();r.store->FlushReplicas();r.DeleteState();
  std::filesystem::remove(r.dir/"identity");std::filesystem::create_directory(r.dir/"identity");
  r.manager=std::make_unique<LicenseManager>(r.machine,r.store,&r.clock);
  r.manager->Init();
  EXPECT_EQ(r.manager->status().state,LicenseState::kTampered);
  EXPECT_NE(r.manager->status().reason.find("RECOVERY_CHALLENGE_WRITE_FAILED"),std::string::npos);
  EXPECT_EQ(r.store->RegistrationRequest().at("request_kind"),"activate");
}
TEST(LicenseV3,SignedMigrationPreservesUsedTimeAndCannotBeReused) {
  V3Rig r;r.Stop();
  auto legacy=std::make_shared<StateStore>(std::vector<std::string>{(r.dir/"state").string()},r.key,"",r.machine.code);
  LicenseRecord state;state.fp=r.machine.code;state.license_id=std::string(32,'c');state.token_hash=std::string(64,'a');
  state.boot_id="v3-boot";state.grant_seq=4;state.seq=10;state.activation_wall=r.clock.WallSec()-300;
  state.total_seconds=3600;state.used_ns=300000000000LL;state.reserved_ns=480000000000LL;
  state.last_mono_ns=r.clock.MonoNs();state.last_boot_ns=r.clock.BootNs();legacy->Save(state);legacy.reset();
  // Manufacture the ticket offline, as the real issuer does. Starting the v3
  // service against v2 state without it is deliberately prohibited.
  r.store=std::make_shared<StateStore>(std::vector<std::string>{(r.dir/"state").string()},r.key,"",r.machine.code);
  auto envelope=nlohmann::json::parse(std::ifstream(r.dir/"identity"));
  nlohmann::json p={{"v",3},{"product","AINVR"},{"policy","hybrid_local"},{"kid","test"},
    {"machine_code",r.machine.code},{"installation_id",envelope["data"]["installation_id"]},
    {"license_id",state.license_id},{"grant_seq",4},{"duration_minutes",60},
    {"issued_at",r.clock.WallSec()},{"purpose","migrate"},{"challenge",""}};
  p["legacy_token_hash"]=state.token_hash;p["activation_wall"]=state.activation_wall;
  auto ticket=r.Sign(p);r.Restart(ticket);
  ASSERT_EQ(r.manager->status().state,LicenseState::kValid);
  EXPECT_GE(r.manager->status().used_seconds,300);EXPECT_EQ(r.manager->status().activation_wall,state.activation_wall);
  EXPECT_EQ(r.store->Load().record->schema,3);
  r.Stop();r.DeleteState();r.Restart(ticket);EXPECT_TRUE(r.manager->Activate(ticket));
}
TEST(LicenseV3,RequestEndpointIncludesChallengeAndKeepsMachineCode) {
  V3Rig r;LicenseHttpApp app(r.manager.get(),std::string(32,'a'));
  auto response=app.Dispatch({"GET","/api/v1/license/machine-code","",{}});
  auto j=nlohmann::json::parse(response.body);EXPECT_EQ(j["machine_code"],r.machine.code);
  EXPECT_TRUE(j["activation_request"].get<std::string>().starts_with("AINVR-REQ3-"));
}

std::string ReadBytes(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), {}};
}

TEST(LicenseV3,MissingInstallationPathCannotSelectProductionIdentity) {
  V3Rig r;
  nlohmann::json config = {{"machine_code", r.machine.code}, {"device_key", std::string(64, '0')},
    {"admin_api_key", std::string(64, 'a')}, {"signal_keys", nlohmann::json::object()}};
  for (auto client : {"ai-service", "recorder", "console-backend", "enforcer"})
    config["signal_keys"][client] = std::string(64, 'b');
  auto path = r.dir / "config.json";
  std::ofstream(path) << config.dump();
  chmod(path.c_str(), 0600);
  EXPECT_THROW(LoadConfig(path.string()), std::exception);
}

TEST(LicenseV3,WrongDeviceKeyNeverModifiesExistingInstallation) {
  V3Rig r;
  ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));
  r.Stop();
  const auto before = ReadBytes(r.dir / "identity");
  const auto state = ReadBytes(r.dir / "state");
  auto wrong = r.key; wrong[0] = 1;
  StateStore store({(r.dir / "state").string()}, wrong, "", r.machine.code);
  EXPECT_THROW(store.EnableV3((r.dir / "identity").string(), r.keys), std::exception);
  EXPECT_EQ(ReadBytes(r.dir / "identity"), before);
  EXPECT_EQ(ReadBytes(r.dir / "state"), state);
  for (const auto& entry : std::filesystem::directory_iterator(r.dir))
    EXPECT_EQ(entry.path().filename().string().find(".invalid."), std::string::npos);
}

TEST(LicenseV3,MissingMigrationTicketDoesNotCreateIdentityOrChangeLegacyState) {
  V3Rig r; r.Stop();
  std::filesystem::remove(r.dir / "identity");
  StateStore legacy({(r.dir / "state").string()}, r.key, "", r.machine.code);
  LicenseRecord state; state.fp=r.machine.code;state.license_id=std::string(32,'a');
  state.token_hash=std::string(64,'b');state.boot_id="test";state.grant_seq=1;
  state.seq=1;state.total_seconds=3600;state.activation_wall=r.clock.WallSec();
  legacy.Save(state);
  auto before=ReadBytes(r.dir / "state");
  StateStore next({(r.dir / "state").string()}, r.key, "", r.machine.code);
  EXPECT_THROW(next.EnableV3((r.dir / "identity").string(), r.keys), std::exception);
  EXPECT_FALSE(std::filesystem::exists(r.dir / "identity"));
  EXPECT_EQ(ReadBytes(r.dir / "state"), before);
}

TEST(LicenseV3,WrongKeyOnUnlicensedInstallationAlsoPreservesIdentity) {
  V3Rig r; r.Stop();
  auto before=ReadBytes(r.dir/"identity");
  auto wrong=r.key;wrong[0]=1;
  StateStore store({(r.dir/"state").string()},wrong,"",r.machine.code);
  EXPECT_THROW(store.EnableV3((r.dir/"identity").string(),r.keys),std::exception);
  EXPECT_EQ(ReadBytes(r.dir/"identity"),before);
}

TEST(LicenseV3,RevokedRestartDoesNotRewriteDurableState) {
  V3Rig r;ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));
  ASSERT_FALSE(r.manager->Remove());r.Stop();
  auto before=ReadBytes(r.dir/"state");r.Restart();
  EXPECT_EQ(r.manager->status().state,LicenseState::kUnlicensed);
  EXPECT_EQ(ReadBytes(r.dir/"state"),before);
}

class IdentityGateStore : public StateStore {
 public:
  using StateStore::StateStore;
  mutable std::mutex mutex;
  mutable std::condition_variable cv;
  bool block=false;
  mutable bool entered=false;
  void Release() {std::lock_guard lock(mutex);block=false;cv.notify_all();}
 protected:
  void PersistIdentity(const std::string& path,const std::string& value) const override {
    std::unique_lock lock(mutex);
    if(block){entered=true;cv.notify_all();cv.wait_for(lock,std::chrono::seconds(3),[&]{return !block;});}
    lock.unlock();StateStore::PersistIdentity(path,value);
  }
};

TEST(LicenseV3,RequestReadsDurableSnapshotDuringBlockedActivation) {
  V3Rig r;r.Stop();
  auto store=std::make_shared<IdentityGateStore>(std::vector<std::string>{(r.dir/"state").string()},r.key,"",r.machine.code);
  store->EnableV3((r.dir/"identity").string(),r.keys);r.store=store;
  r.manager=std::make_unique<LicenseManager>(r.machine,store,&r.clock);r.manager->Init();
  auto before=r.manager->RegistrationRequest();auto token=r.Sign(r.Payload());
  {std::lock_guard lock(store->mutex);store->block=true;}
  auto activation=std::async(std::launch::async,[&]{return r.manager->Activate(token);});
  {std::unique_lock lock(store->mutex);
   EXPECT_TRUE(store->cv.wait_for(lock,std::chrono::seconds(2),[&]{return store->entered;}));}
  auto request=std::async(std::launch::async,[&]{return r.manager->RegistrationRequest();});
  EXPECT_EQ(request.wait_for(std::chrono::milliseconds(200)),std::future_status::ready);
  store->Release();EXPECT_EQ(request.get(),before);EXPECT_FALSE(activation.get());
  EXPECT_NE(r.manager->RegistrationRequest(),before);
}

TEST(LicenseV3,BadMigrationTicketLeavesBoardRetryable) {
  V3Rig r;auto payload=r.Payload(4);r.Stop();std::filesystem::remove(r.dir/"identity");
  StateStore legacy({(r.dir/"state").string()},r.key,"",r.machine.code);
  LicenseRecord state;state.fp=r.machine.code;state.license_id=payload["license_id"];
  state.token_hash=std::string(64,'a');state.boot_id="v3-boot";state.grant_seq=4;
  state.seq=1;state.total_seconds=3600;state.activation_wall=r.clock.WallSec()-300;
  state.used_ns=300000000000LL;state.reserved_ns=480000000000LL;
  legacy.Save(state);auto before=ReadBytes(r.dir/"state");
  payload["purpose"]="migrate";payload["legacy_token_hash"]=std::string(64,'b');
  payload["activation_wall"]=state.activation_wall;
  StateStore bad({(r.dir/"state").string()},r.key,"",r.machine.code);
  EXPECT_THROW(bad.EnableV3((r.dir/"identity").string(),r.keys,r.Sign(payload)),std::exception);
  EXPECT_FALSE(std::filesystem::exists(r.dir/"identity"));EXPECT_EQ(ReadBytes(r.dir/"state"),before);
  payload["legacy_token_hash"]=state.token_hash;r.Restart(r.Sign(payload));
  EXPECT_EQ(r.manager->status().state,LicenseState::kValid);
  EXPECT_GE(r.manager->status().used_seconds,300);
}
}
// 系统时间早于 2026-01-01 必然是错的(没装时钟电池的设备首次上电、或从未对过时):
// 授权对外报"时钟错误/系统时间无效",各服务据此暂停;不动持久化授权、不因时间跳变额外消耗;
// 时间校准后下一次计算自动恢复,无需重启授权服务。
TEST(LicenseV3,SystemTimeBefore2026IsReportedInvalidAndRecoversWhenCorrected) {
  V3Rig r;ASSERT_FALSE(r.manager->Activate(r.Sign(r.Payload())));
  r.clock.AdvanceNormal(30);
  auto before=r.manager->status();ASSERT_EQ(before.state,LicenseState::kValid);
  r.clock.SetWall(1735689600);  // 2025-01-01
  auto bad=r.manager->status();
  EXPECT_EQ(bad.state,LicenseState::kClockError);
  EXPECT_EQ(bad.reason,"SYSTEM_TIME_INVALID");
  EXPECT_EQ(bad.lease_ms,0);
  EXPECT_LE(bad.used_seconds,before.used_seconds+1);
  r.clock.SetWall(1767225600-1);  // 2025-12-31 23:59:59 UTC 仍无效
  EXPECT_EQ(r.manager->status().reason,"SYSTEM_TIME_INVALID");
  r.clock.SetWall(1800000060);
  r.clock.AdvanceMonoSec(1);
  auto good=r.manager->status();
  EXPECT_EQ(good.state,LicenseState::kValid);
  EXPECT_NE(good.reason,"SYSTEM_TIME_INVALID");
}

#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <memory>
#include <thread>
#include "crypto.hpp"
#include "signed_license.hpp"
namespace ainvr_license {
struct LicenseRecord {
  int schema=2;
  bool revoked=false;
  std::string fp,license_id,token_hash,boot_id;
  std::string installation_id,signed_grant;
  int64_t grant_seq=0,seq=0,activation_wall=0,total_seconds=0;
  int64_t used_ns=0,reserved_ns=0,last_mono_ns=0,last_boot_ns=0;
};
struct LoadOutcome {
  bool any_file_present=false,tampered=false,storage_error=false,migrated=false;
  std::string reason;
  std::optional<LicenseRecord> record;
};
// First path is the sole commit point; others are recovery copies.
class StateStore {
 public:
  using RecoveryWriter = std::function<void(const std::string&, const std::string&)>;
  StateStore(std::vector<std::string> paths,Key32 device_key,std::string chip_uid,std::string fp);
  StateStore(std::vector<std::string> paths,Key32 device_key,std::string chip_uid,std::string fp,RecoveryWriter writer);
  virtual ~StateStore();
  virtual LoadOutcome Load() const;
  virtual void Save(const LicenseRecord&) const;
  void FlushReplicas() const;
  int64_t PrimaryWriteMs() const { return primary_ms_.load(); }
  int64_t ReplicaWriteMs() const { return replica_ms_.load(); }
  int64_t PrimarySeq() const { return primary_seq_.load(); }
  int64_t ReplicaSeq() const { return replica_seq_.load(); }
  std::string CanonicalData(const LicenseRecord&) const;
  const Key32& DerivedKey() const{return dk_;}
  // Called once, before the manager starts. Production always enables v3.
  void EnableV3(std::string identity_path, VerifyKeys keys, std::string migration_token = {});
  bool V3() const { return !identity_path_.empty(); }
  SignedGrant VerifyGrant(const std::string& token) const;
  nlohmann::json RegistrationRequest() const;
  void RequireRecovery() const;
  std::string InstallationId() const;
  int64_t GrantFloor() const;
 protected:
  virtual void PersistIdentity(const std::string& path, const std::string& value) const;
 private:
  void WriteIdentity(const nlohmann::json&) const;
  void AnchorGrant(const LicenseRecord&) const;
  mutable std::mutex identity_mu_;
  mutable nlohmann::json identity_;
  // Readers see only the last durable snapshot and never wait for disk writes.
  mutable std::shared_ptr<const nlohmann::json> published_identity_;
  std::string identity_path_,migration_token_;
  VerifyKeys verify_keys_;
  std::vector<std::string> paths_;
  Key32 dk_;
  std::string fp_;
  void ReplicaLoop();
  RecoveryWriter recovery_writer_;
  mutable std::mutex replica_mu_;
  mutable std::condition_variable replica_cv_;
  struct PendingReplica { int64_t seq; std::string value; };
  mutable std::optional<PendingReplica> pending_replica_;
  mutable bool replica_busy_=false;
  bool replica_stop_=false;
  mutable std::atomic<int64_t> primary_ms_{0},replica_ms_{0},primary_seq_{0},replica_seq_{0};
  std::thread replica_worker_;
};
void AtomicPrivateWrite(const std::string& path,const std::string& value);
}

#pragma once
#include <cstdint>
#include <string>
namespace ainvr_license {
enum class LicenseState {kUnlicensed,kValid,kExpired,kTampered,kStorageError,kClockError};
inline const char* StateName(LicenseState s){switch(s){case LicenseState::kUnlicensed:return "unlicensed";case LicenseState::kValid:return "valid";case LicenseState::kExpired:return "expired";case LicenseState::kTampered:return "recovery_required";case LicenseState::kStorageError:return "storage_error";case LicenseState::kClockError:return "clock_error";}return "recovery_required";}
struct StatusSnapshot {
  LicenseState state=LicenseState::kUnlicensed;
  std::string mode="hybrid_local",fingerprint,soc_model,reason,license_id,daemon_epoch;
  int64_t remaining_minutes=-1,remaining_seconds=0,total_seconds=0,used_seconds=0;
  int64_t expires_min=0,seq=0,grant_seq=0,activation_wall=0,lease_ms=0;
  bool service_ok=true,enforcer_tripped=false;
};
}

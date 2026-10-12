#pragma once
#include <map>
#include <string>
#include <nlohmann/json.hpp>
#include "license_payload.hpp"

namespace ainvr_license {
using VerifyKeys = std::map<std::string, std::string>;
// The production executable contains public keys only. Tests inject synthetic keys.
VerifyKeys ProductionVerifyKeys();
struct SignedGrant {
  LicensePayload license;
  std::string installation_id, purpose, challenge, legacy_token_hash;
  int64_t activation_wall = 0;
};
SignedGrant OpenSignedGrant(const VerifyKeys&, const std::string& token);
}

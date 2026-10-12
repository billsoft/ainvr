#pragma once
#include <string>
#include <unordered_map>
#include <vector>
#include "crypto.hpp"
namespace ainvr_license {
struct ServiceConfig {
  std::string host="127.0.0.1";
  int port=8001;
  std::string uds_path="/run/ainvr-license/license.sock",admin_api_key,expected_machine;
  Key32 device_key{};
  std::string state_primary="/var/lib/ainvr-license/state.dat";
  std::string state_replica2="/var/lib/ainvr-license/recovery-1.dat";
  std::string state_replica3="/var/lib/ainvr-license/recovery-2.dat";
  std::string installation_path; // Explicit in every configuration, including tests.
  std::string migration_file;
  std::unordered_map<std::string,Key32>signal_keys;
  std::vector<std::string>StatePaths()const{return {state_primary,state_replica2,state_replica3};}
};
ServiceConfig LoadConfig(const std::string&path);
}

// HTTP 业务分发：TCP(httplib) 与 UDS(自带极简解析器) 共用同一个 Dispatch。
#pragma once

#include <atomic>
#include <string>
#include <unordered_map>

#include "license_manager.hpp"

namespace ainvr_license {

struct WebRequest {
  std::string method;
  std::string target;  // 含 query
  std::string body;
  std::unordered_map<std::string, std::string> headers;
};

struct WebResponse {
  int status = 200;
  std::string body;
};

class LicenseHttpApp {
 public:
  LicenseHttpApp(LicenseManager* manager, std::string admin_api_key);

  void set_enforcer_tripped(bool v) { enforcer_tripped_ = v; }

  WebResponse Dispatch(const WebRequest& req) const;

 private:
  LicenseManager* mgr_;
  std::string admin_key_;
  std::atomic<bool> enforcer_tripped_{false};
};

}  // namespace ainvr_license

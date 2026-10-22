#pragma once
#include <nlohmann/json.hpp>
#include <string>

namespace ainvr::llm {
// Protected by the service mutex. A configuration is acknowledged only after
// its requested model state is reached. Late completions cannot acknowledge a
// newer version, and a failed attempt never replaces the committed version.
class ConfigurationState {
 public:
  void Begin(int version) { attempted_ = version; pending_ = true; error_.clear(); }
  bool Commit(int version) {
    if (!pending_ || version != attempted_) return false;
    committed_ = version;
    pending_ = false;
    return true;
  }
  void Fail(int version, const std::string& error) {
    if (version != attempted_) return;
    pending_ = false;
    error_ = error;
  }
  int committed() const { return committed_; }
  int attempted() const { return attempted_; }
  nlohmann::json Report() const {
    nlohmann::json result = {
      {"status", pending_ ? "pending" : error_.empty() ? "applied" : "failed"},
      {"restartRequired", false}, {"errorMessage", error_}};
    if (committed_) result["appliedVersion"] = committed_;
    return result;
  }
 private:
  int committed_ = 0, attempted_ = 0;
  bool pending_ = false;
  std::string error_;
};
}  // namespace ainvr::llm

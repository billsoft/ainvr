#pragma once
#include <nlohmann/json.hpp>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

namespace ainvr {
// Shared protocol 2 lifetime reservation, extracted without changing the lock,
// registry or conservative budget. This is EXCLUSIVE, not a coexistence grant.
// Release only after all model/image allocations are safely destroyed.
class BpuReservation {
 public:
  BpuReservation(std::string directory, uint64_t bytes, uint64_t headroom,
                 uint64_t total, std::string service = "llm-service")
      : directory_(std::move(directory)), service_(std::move(service)), bytes_(bytes) {
    if (service_ != "llm-service" && service_ != "search-service")
      throw std::runtime_error("invalid_reservation_service");
    constexpr uint64_t other = 1024ULL * 1024 * 1024;
    if (!bytes || total < other || headroom > total - other || bytes > total - other - headroom)
      throw std::runtime_error("ion_budget_exceeded");
    fd_ = open((directory_ + "/bpu-reservation.lock").c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd_ < 0) throw std::runtime_error("reservation_lock_unavailable");
    if (flock(fd_, LOCK_EX | LOCK_NB)) {
      close(fd_); fd_ = -1; throw std::runtime_error("large_model_busy");
    }
    try {
      const auto path = directory_ + "/bpu-reservations.json";
      if (std::filesystem::exists(path)) {
        std::ifstream file(path); nlohmann::json registry; file >> registry;
        if (!registry.at("holders").is_array()) throw std::runtime_error("invalid reservation registry");
        for (const auto& holder : registry.at("holders")) {
          const auto identity = Identity(holder.at("pid").get<int>());
          if (!identity.empty() && identity == holder.at("start_ticks").get<std::string>())
            throw std::runtime_error("uncoordinated_model_holder");
        }
      }
      holder_ = {{"service", service_}, {"pid", getpid()}, {"start_ticks", Identity(getpid())},
                 {"bytes", bytes}, {"state", "loading"}, {"protocol", 2}};
      if (holder_.at("start_ticks") == "") throw std::runtime_error("process identity unavailable");
      Write(nlohmann::json::array({holder_})); owned_ = true;
    } catch (...) { close(fd_); fd_ = -1; throw; }
  }
  ~BpuReservation() {
    if (fd_ >= 0) {
      if (owned_) try { Write(nlohmann::json::array()); } catch (...) {}
      close(fd_);
    }
  }
  BpuReservation(const BpuReservation&) = delete;
  BpuReservation& operator=(const BpuReservation&) = delete;
  void Loaded() { holder_["state"] = "loaded"; Write(nlohmann::json::array({holder_})); }
  const std::string& Service() const noexcept { return service_; }
  uint64_t Bytes() const noexcept { return bytes_; }
 private:
  static std::string Identity(int pid) {
    if (pid <= 0) throw std::runtime_error("invalid holder pid");
    std::ifstream file("/proc/" + std::to_string(pid) + "/stat");
    std::string line; std::getline(file, line); const auto end = line.rfind(')');
    if (end == std::string::npos) {
      if (std::filesystem::exists("/proc/" + std::to_string(pid)))
        throw std::runtime_error("holder identity unreadable");
      return "";
    }
    std::istringstream fields(line.substr(end + 2)); std::string value;
    for (int index = 3; index <= 22; ++index)
      if (!(fields >> value)) throw std::runtime_error("invalid process identity");
    return value;
  }
  void Write(const nlohmann::json& rows) {
    const auto path = directory_ + "/bpu-reservations.json";
    const auto temporary = path + "." + std::to_string(getpid()) + ".tmp";
    {
      std::ofstream file(temporary);
      file << nlohmann::json({{"protocol", 2}, {"holders", rows}}).dump(); file.flush();
      if (!file) throw std::runtime_error("reservation_write_failed");
    }
    std::filesystem::rename(temporary, path);
  }
  std::string directory_, service_;
  uint64_t bytes_;
  nlohmann::json holder_;
  int fd_ = -1;
  bool owned_ = false;
};
}  // namespace ainvr

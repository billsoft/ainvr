// Copyright AINVR. Reused original runtime diagnostics.
#pragma once
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <chrono>
#include <algorithm>
#include <cstddef>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

namespace ai_service::utils {
inline bool NotifySystemd(const std::string& path, const char* message) {
  sockaddr_un address{};
  if (path.empty() || path.size() >= sizeof(address.sun_path)) return false;
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.data(), path.size());
  const bool abstract = path[0] == '@';
  if (abstract) address.sun_path[0] = '\0';
  int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) return false;
  const auto length = offsetof(sockaddr_un, sun_path) + path.size() + (abstract ? 0 : 1);
  const bool ok = sendto(fd, message, std::strlen(message), MSG_NOSIGNAL,
                        reinterpret_cast<sockaddr*>(&address), length) >= 0;
  close(fd);
  return ok;
}

// Probe only control-plane liveness. Archive backpressure is not a crash.
// The supplied probe must have bounded I/O and must not wait on archive locks.
class SystemdWatchdog {
 public:
  explicit SystemdWatchdog(std::function<bool()> probe) {
    const char* socket = std::getenv("NOTIFY_SOCKET");
    const char* usec = std::getenv("WATCHDOG_USEC");
    const char* pid = std::getenv("WATCHDOG_PID");
    if (!socket || !usec) return;
    try {
      if (pid && std::stoll(pid) != getpid()) return;
      auto us = std::stoll(usec);
      if (us <= 0) return;
      auto period = std::chrono::microseconds(std::max(1000LL, std::min(10000000LL, us / 3)));
      thread_ = std::thread([this, probe = std::move(probe), path = std::string(socket), period] {
        std::unique_lock<std::mutex> lock(mu_);
        while (!stopped_) {
          lock.unlock();
          bool alive = false;
          try { alive = probe(); } catch (...) {}
          NotifySystemd(path, alive ? "WATCHDOG=1\nSTATUS=Control plane responsive" :
                                     "STATUS=Control plane unresponsive; watchdog pending");
          lock.lock();
          wake_.wait_for(lock, period, [this] { return stopped_; });
        }
      });
    } catch (...) { /* Invalid service environment: do not send fake heartbeats. */ }
  }
  ~SystemdWatchdog() { Stop(); }
  void Stop() {
    { std::lock_guard<std::mutex> lock(mu_); stopped_ = true; }
    wake_.notify_all();
    if (thread_.joinable()) thread_.join();
  }
 private:
  std::mutex mu_;
  std::condition_variable wake_;
  bool stopped_ = false;
  std::thread thread_;
};
}  // namespace ai_service::utils

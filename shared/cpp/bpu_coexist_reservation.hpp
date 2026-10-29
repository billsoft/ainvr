#pragma once
// Protocol 3: byte-accounted COEXISTENCE of resident BPU models (llm-service, search-service, ...).
//
// Why this exists: protocol 2 (bpu_reservation.hpp) is deliberately EXCLUSIVE - one resident model per ION pool, with a fixed
// 1 GiB allowance for everybody else and the holder's own *declared* size. On the S100P that wastes memory twice: ai-service
// really holds ~200 MiB (not 1 GiB) and Qwen3-VL really holds ~5.46 GiB (its manifest says 5.25 GiB).
//
// What it does:
//  * every holder keeps a SHARED flock on bpu-reservation.lock for its whole life. Protocol-2 holders need the same file
//    EXCLUSIVELY, so old and new protocols stay mutually exclusive in both directions (LocateAnything's executor and an old
//    llm-service binary keep working unchanged and still exclude us).
//  * admission is serialised by a short exclusive lock on bpu-admission.lock and recorded as one row per holder in
//    bpu-reservations.json (rows keep pid/start_ticks/bytes/state, so protocol-2 readers still treat them as live holders).
//  * a new holder is admitted only if
//        sum(live holders: max(declared, measured fdinfo)) + max(other_floor, measured unregistered ION + other_growth)
//        + its own declared bytes + min_free  <=  pool
//    "measured" is /proc/<pid>/fdinfo (dmabuf, exp_name ion, de-duplicated by inode): a LOWER BOUND of what a process holds. It
//    is used to size the allowance for processes we do not manage; it is never treated as free memory, and the allowance and
//    min_free stay explicit knobs. /sys/kernel/debug/ion is never read.
#include <nlohmann/json.hpp>
#include <dirent.h>
#include <cctype>
#include <cerrno>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

namespace ainvr {

struct IonPolicy {
  uint64_t pool_bytes = 0;                           // ReadBpuReservedPoolBytes(), capped by the caller
  uint64_t other_floor = 256ULL << 20;               // minimum allowance for unmanaged ION users (ai-service, ...)
  uint64_t other_growth = 128ULL << 20;              // headroom added on top of their measured holding
  uint64_t min_free = 256ULL << 20;                  // must stay free after admission; also the post-load probe size
};

struct IonHolder { int pid = 0; std::string service; uint64_t declared = 0; uint64_t measured = 0; };

struct IonDecision {
  bool ok = false;
  std::string reason;                                // "" or "ion_budget_exceeded"
  uint64_t registered_used = 0, other_reserved = 0, need = 0;
  int64_t spare = 0;                                 // pool - (registered_used + other_reserved + need + min_free)
  nlohmann::json ToJson() const {
    return {{"ok", ok}, {"reason", reason}, {"registered_used_bytes", registered_used}, {"other_reserved_bytes", other_reserved},
            {"need_bytes", need}, {"spare_bytes", spare}};
  }
};

// Pure function: all numbers in, decision out. This is what the unit tests pin down.
inline IonDecision EvaluateIonAdmission(const IonPolicy& policy, const std::vector<IonHolder>& live,
                                        uint64_t unregistered_measured, uint64_t need) {
  IonDecision d;
  d.need = need;
  for (const auto& h : live) d.registered_used += std::max(h.declared, h.measured);
  d.other_reserved = std::max(policy.other_floor, unregistered_measured + policy.other_growth);
  const __int128 total = static_cast<__int128>(d.registered_used) + d.other_reserved + need + policy.min_free;
  d.spare = static_cast<int64_t>(static_cast<__int128>(policy.pool_bytes) - total);
  d.ok = d.spare >= 0;
  if (!d.ok) d.reason = "ion_budget_exceeded";
  return d;
}

// ION held by one process, from fdinfo only (lower bound; inodes de-duplicated).
inline uint64_t IonBytesOfPid(int pid) {
  std::unordered_set<std::string> seen;
  uint64_t total = 0;
  const std::string base = "/proc/" + std::to_string(pid) + "/fdinfo";
  std::error_code ec;
  for (const auto& entry : std::filesystem::directory_iterator(base, ec)) {
    std::ifstream file(entry.path());
    std::string line, ino, size;
    bool ion = false;
    while (std::getline(file, line)) {
      if (line.rfind("exp_name:", 0) == 0 && line.find("ion") != std::string::npos) ion = true;
      else if (line.rfind("ino:", 0) == 0) ino = line.substr(4);
      else if (line.rfind("size:", 0) == 0) size = line.substr(5);
    }
    if (!ion || ino.empty() || size.empty() || !seen.insert(ino).second) continue;
    try { total += std::stoull(size); } catch (...) {}
  }
  return total;
}

inline uint64_t IonBytesOfOthers(const std::set<int>& exclude) {
  uint64_t total = 0;
  std::error_code ec;
  for (const auto& entry : std::filesystem::directory_iterator("/proc", ec)) {
    const auto name = entry.path().filename().string();
    if (name.empty() || !std::all_of(name.begin(), name.end(), [](unsigned char c) { return std::isdigit(c); })) continue;
    const int pid = std::stoi(name);
    if (!exclude.count(pid)) total += IonBytesOfPid(pid);
  }
  return total;
}

struct IonProbe {                                    // replaceable in tests
  std::function<uint64_t(int)> pid_bytes = [](int pid) { return IonBytesOfPid(pid); };
  std::function<uint64_t(const std::set<int>&)> others_bytes = [](const std::set<int>& e) { return IonBytesOfOthers(e); };
};

class BpuCoexistReservation {
 public:
  BpuCoexistReservation(std::string directory, std::string service, uint64_t declared_bytes, IonPolicy policy,
                        IonProbe probe = IonProbe{})
      : directory_(std::move(directory)), service_(std::move(service)), bytes_(declared_bytes) {
    if (service_ != "llm-service" && service_ != "search-service") throw std::runtime_error("invalid_reservation_service");
    if (!declared_bytes || !policy.pool_bytes || declared_bytes > policy.pool_bytes || policy.min_free < (64ULL << 20))
      throw std::runtime_error("ion_budget_exceeded");
    // 1. lifetime SHARED lock: excludes protocol-2 (exclusive) holders, coexists with other protocol-3 holders.
    life_fd_ = open((directory_ + "/bpu-reservation.lock").c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (life_fd_ < 0) throw std::runtime_error("reservation_lock_unavailable");
    if (flock(life_fd_, LOCK_SH | LOCK_NB)) { CloseLife(); throw std::runtime_error("large_model_busy"); }
    try {
      AdmissionLock lock(directory_);
      auto rows = LiveRows(lock.fd);
      std::vector<IonHolder> live;
      // Only registered live holders are excluded from the unmanaged census.
      // Before this process's first reservation it may already own AI/video
      // DMA; excluding getpid() here would silently omit that whole baseline.
      std::set<int> known;
      for (const auto& row : rows) {
        if (row.value("protocol", 0) != 3) throw std::runtime_error("uncoordinated_model_holder");
        const int pid = row.at("pid").get<int>();
        const uint64_t declared = row.at("bytes").get<uint64_t>();
        // One process may hold several reservations (e.g. two towers): fdinfo measures the whole process once, so rows of the
        // same pid are merged into a single holder (sum of declared, measured once) instead of being counted repeatedly.
        auto same = std::find_if(live.begin(), live.end(), [&](const IonHolder& h) { return h.pid == pid; });
        if (same != live.end()) { same->declared += declared; continue; }
        IonHolder h{pid, row.at("service").get<std::string>(), declared, probe.pid_bytes(pid)};
        known.insert(pid);
        live.push_back(h);
      }
      decision_ = EvaluateIonAdmission(policy, live, probe.others_bytes(known), declared_bytes);
      if (!decision_.ok) throw std::runtime_error(decision_.reason);
      holder_ = {{"service", service_}, {"pid", getpid()}, {"start_ticks", Identity(getpid())},
                 {"bytes", declared_bytes}, {"state", "loading"}, {"protocol", 3}, {"slot", NextSlot()}};
      if (holder_.at("start_ticks") == "") throw std::runtime_error("process identity unavailable");
      rows.push_back(holder_);
      Write(rows, lock.fd);
      owned_ = true;
    } catch (...) { CloseLife(); throw; }
  }
  ~BpuCoexistReservation() {
    if (owned_) try { AdmissionLock lock(directory_); auto rows = LiveRows(lock.fd); rows = Without(rows, getpid(), holder_.at("slot").get<uint64_t>()); Write(rows, lock.fd); } catch (...) {}
    CloseLife();
  }
  BpuCoexistReservation(const BpuCoexistReservation&) = delete;
  BpuCoexistReservation& operator=(const BpuCoexistReservation&) = delete;
  void Loaded() {
    AdmissionLock lock(directory_);
    auto rows = LiveRows(lock.fd);
    const auto slot = holder_.at("slot").get<uint64_t>();
    for (auto& row : rows) if (row.value("pid", 0) == getpid() && row.value("slot", uint64_t(0)) == slot) row["state"] = "loaded";
    Write(rows, lock.fd);
  }
  const std::string& Service() const noexcept { return service_; }
  uint64_t Bytes() const noexcept { return bytes_; }
  const IonDecision& Decision() const noexcept { return decision_; }

 private:
  using Json = nlohmann::json;
  struct AdmissionLock {                             // short exclusive lock with a bounded wait
    int fd = -1;
    explicit AdmissionLock(const std::string& dir) {
      fd = open((dir + "/bpu-admission.lock").c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (fd < 0) throw std::runtime_error("reservation_lock_unavailable");
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
      while (flock(fd, LOCK_EX | LOCK_NB)) {
        if (std::chrono::steady_clock::now() > deadline) { close(fd); fd = -1; throw std::runtime_error("admission_lock_timeout"); }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
    }
    ~AdmissionLock() { if (fd >= 0) close(fd); }
    AdmissionLock(const AdmissionLock&) = delete;
    AdmissionLock& operator=(const AdmissionLock&) = delete;
  };
  void CloseLife() noexcept { if (life_fd_ >= 0) { close(life_fd_); life_fd_ = -1; } }
  static std::string Identity(int pid) {
    if (pid <= 0) throw std::runtime_error("invalid holder pid");
    std::ifstream file("/proc/" + std::to_string(pid) + "/stat");
    std::string line; std::getline(file, line); const auto end = line.rfind(')');
    if (end == std::string::npos) {
      if (std::filesystem::exists("/proc/" + std::to_string(pid))) throw std::runtime_error("holder identity unreadable");
      return "";
    }
    std::istringstream fields(line.substr(end + 2)); std::string value;
    for (int index = 3; index <= 22; ++index)
      if (!(fields >> value)) throw std::runtime_error("invalid process identity");
    return value;
  }
  struct RegistryFd {
    int fd = -1;
    explicit RegistryFd(int value) : fd(value) {}
    ~RegistryFd() { if (fd >= 0) close(fd); }
    RegistryFd(const RegistryFd&) = delete;
    RegistryFd& operator=(const RegistryFd&) = delete;
  };
  static struct stat RegistryOwner(int admission_fd) {
    struct stat owner{};
    if (fstat(admission_fd, &owner) || !S_ISREG(owner.st_mode) || owner.st_nlink != 1 || (owner.st_mode & 0022))
      throw std::runtime_error("reservation_registry_unavailable");
    return owner;
  }
  static void TrustedRegistry(int fd, const struct stat& owner) {
    struct stat actual{};
    if (fstat(fd, &actual) || !S_ISREG(actual.st_mode) || actual.st_nlink != 1 ||
        actual.st_uid != owner.st_uid || actual.st_gid != owner.st_gid || (actual.st_mode & 0022))
      throw std::runtime_error("reservation_registry_unavailable");
  }
  Json LiveRows(int admission_fd) const {              // drops rows whose process is gone or was replaced (pid reuse)
    const auto path = directory_ + "/bpu-reservations.json";
    Json live = Json::array();
    const auto owner = RegistryOwner(admission_fd);
    RegistryFd file(open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
    if (file.fd < 0) {
      if (errno == ENOENT) return live;
      throw std::runtime_error("reservation_registry_unavailable");
    }
    TrustedRegistry(file.fd, owner);
    std::string text;
    char buffer[4096];
    while (true) {
      const auto count = read(file.fd, buffer, sizeof(buffer));
      if (count < 0) { if (errno == EINTR) continue; throw std::runtime_error("reservation_registry_unavailable"); }
      if (!count) break;
      text.append(buffer, static_cast<size_t>(count));
    }
    const auto registry = Json::parse(text);
    if (!registry.contains("holders") || !registry.at("holders").is_array()) throw std::runtime_error("invalid reservation registry");
    for (const auto& row : registry.at("holders")) {
      const auto identity = Identity(row.at("pid").get<int>());
      if (!identity.empty() && identity == row.at("start_ticks").get<std::string>()) live.push_back(row);
    }
    return live;
  }
  static Json Without(const Json& rows, int pid, uint64_t slot) {   // removes only this reservation, not its process's others
    Json out = Json::array();
    for (const auto& row : rows) if (!(row.value("pid", 0) == pid && row.value("slot", uint64_t(0)) == slot)) out.push_back(row);
    return out;
  }
  static uint64_t NextSlot() { static std::atomic<uint64_t> counter{0}; return ++counter; }
  void Write(const Json& rows, int admission_fd) const {
    const auto path = directory_ + "/bpu-reservations.json";
    const auto owner = RegistryOwner(admission_fd);
    RegistryFd existing(open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
    if (existing.fd >= 0) TrustedRegistry(existing.fd, owner);
    else if (errno != ENOENT) throw std::runtime_error("reservation_registry_unavailable");
    static std::atomic<uint64_t> sequence{0};
    const auto temporary = path + "." + std::to_string(getpid()) + "." + std::to_string(++sequence) + ".tmp";
    RegistryFd file(open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600));
    if (file.fd < 0) throw std::runtime_error("reservation_write_failed");
    struct stat created{};
    const bool identified = fstat(file.fd, &created) == 0;
    try {
      if (!identified || ((created.st_uid != owner.st_uid || created.st_gid != owner.st_gid) &&
                          fchown(file.fd, owner.st_uid, owner.st_gid)) || fchmod(file.fd, 0600))
        throw std::runtime_error("reservation_write_failed");
      const auto text = Json({{"protocol", 3}, {"holders", rows}}).dump();
      size_t offset = 0;
      while (offset < text.size()) {
        const auto count = write(file.fd, text.data() + offset, text.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) throw std::runtime_error("reservation_write_failed");
        offset += static_cast<size_t>(count);
      }
      if (fsync(file.fd)) throw std::runtime_error("reservation_write_failed");
      const auto fd = file.fd; file.fd = -1;
      if (close(fd) || rename(temporary.c_str(), path.c_str())) throw std::runtime_error("reservation_write_failed");
    } catch (...) {
      // Do not unlink a pre-existing or substituted temporary belonging to a
      // different writer. The committed registry is untouched on write failure.
      struct stat current{};
      if (identified && lstat(temporary.c_str(), &current) == 0 &&
          current.st_dev == created.st_dev && current.st_ino == created.st_ino)
        unlink(temporary.c_str());
      throw;
    }
  }
  std::string directory_, service_;
  uint64_t bytes_;
  Json holder_;
  IonDecision decision_;
  int life_fd_ = -1;
  bool owned_ = false;
};
}  // namespace ainvr

// Copyright AINVR. Adapted for the S100P service.
#include "config_store.hpp"
#include "durable_file.hpp"

#include <cerrno>
#include <cstdio>
#include <fstream>
#include <stdexcept>

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <yaml-cpp/yaml.h>

#include "yaml_json.hpp"

namespace ai_service::config {

namespace {
namespace fs = std::filesystem;
using nlohmann::json;
}  // namespace

nlohmann::json DeepMerge(const nlohmann::json& base, const nlohmann::json& overlay) {
  if (!overlay.is_object()) return overlay;
  json result = base.is_object() ? base : json::object();
  for (auto it = overlay.begin(); it != overlay.end(); ++it) {
    const std::string& key = it.key();
    if (result.contains(key) && result[key].is_object() && it.value().is_object()) {
      result[key] = DeepMerge(result[key], it.value());
    } else {
      result[key] = it.value();
    }
  }
  return result;
}

std::filesystem::path DeriveOverlayPath(const std::filesystem::path& config_path) {
  fs::path resolved = fs::weakly_canonical(config_path);
  return resolved.parent_path().parent_path() / "data" / "config_overlay.json";
}

ConfigStore::ConfigStore(std::filesystem::path base_path, std::filesystem::path overlay_path)
    : base_path_(std::move(base_path)), overlay_path_(std::move(overlay_path)) {
  fs::create_directories(overlay_path_.parent_path());
  lock_path_ = overlay_path_;
  lock_path_ += ".lock";
}

nlohmann::json ConfigStore::ReadYaml(const std::filesystem::path& path) {
  if (!fs::exists(path)) return json::object();
  YAML::Node root = YAML::LoadFile(path.string());
  json j = YamlToJson(root);
  return j.is_null() ? json::object() : j;
}

nlohmann::json ConfigStore::ReadJson(const std::filesystem::path& path) {
  if (!fs::exists(path)) return json::object();
  try {
    std::ifstream f(path);
    json j;
    f >> j;
    return j.is_null() ? json::object() : j;
  } catch (...) {
    // Never silently activate the base configuration when the desired overlay
    // is unreadable. Do not include file contents or credentials in the error.
    throw std::runtime_error("configuration overlay unreadable or invalid");
  }
}

nlohmann::json ConfigStore::ReadMergedRaw() const {
  return DeepMerge(ReadYaml(base_path_), ReadJson(overlay_path_));
}

AppConfig ConfigStore::Load() const {
  std::lock_guard<std::mutex> lock(process_mutex_);
  if (!runtime_synchronized_ || activation_restart_required_) throw std::runtime_error("runtime configuration synchronization pending");
  return AppConfigFromJson(ReadMergedRaw());
}

AppConfig ConfigStore::LoadPersisted() const {
  std::lock_guard<std::mutex> lock(process_mutex_);
  return AppConfigFromJson(ReadMergedRaw());
}

nlohmann::json ConfigStore::RuntimeStatus() const {
  std::lock_guard<std::mutex> lock(process_mutex_);
  return {{"state",activation_restart_required_?(runtime_synchronized_?"restarting":"pending"):(runtime_synchronized_?"applied":"pending")},
          {"runtime_synchronized",runtime_synchronized_ && !activation_restart_required_},
          {"model_demands_synchronized",runtime_synchronized_},
          {"restart_required",activation_restart_required_},{"synchronization_failures",runtime_failures_}};
}

bool ConfigStore::ActivationRestartReady() const {
  std::lock_guard<std::mutex> lock(process_mutex_);
  return activation_restart_required_ && runtime_synchronized_;
}

nlohmann::json ConfigStore::LoadRawMerged() const { return ReadMergedRaw(); }

nlohmann::json ConfigStore::LoadOverlayRaw() const { return ReadJson(overlay_path_); }

AppConfig ConfigStore::ValidateOrRaise(const nlohmann::json& overlay) const {
  json merged = DeepMerge(ReadYaml(base_path_), overlay);
  return AppConfigFromJson(merged);  // 抛 ConfigValidationError
}

namespace {
// 跨进程互斥:整个 read-modify-write 周期持锁(覆盖校验+写入两步),
// 不只锁最内层的磁盘写入——config_store.py 原有设计,防止两个并发请求
// 各自基于同一份旧快照算出新列表、互相覆盖。
class FileLock {
 public:
  explicit FileLock(const fs::path& path) {
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR, 0600);
    if (fd_ < 0) throw std::runtime_error("无法打开锁文件: " + path.string());
    if (::flock(fd_, LOCK_EX) != 0) {
      ::close(fd_);
      throw std::runtime_error("获取文件锁失败: " + path.string());
    }
  }
  ~FileLock() {
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_UN);
      ::close(fd_);
    }
  }
  FileLock(const FileLock&) = delete;
  FileLock& operator=(const FileLock&) = delete;

 private:
  int fd_ = -1;
};
}  // namespace

void ConfigStore::NotifyRuntimeLocked(const AppConfig& config) {
  runtime_synchronized_ = false;
  try { if (runtime_observer_) runtime_observer_(config); }
  catch (...) { ++runtime_failures_; throw RuntimeSyncPending(); }
  runtime_synchronized_ = true;
}

void ConfigStore::SetRuntimeObserver(std::function<void(const AppConfig&)> observer) {
  std::lock_guard<std::mutex> lock(process_mutex_);
  FileLock file_lock(lock_path_);
  runtime_observer_ = std::move(observer);
  runtime_synchronized_ = false;
  NotifyRuntimeLocked(ValidateOrRaise(ReadJson(overlay_path_)));
}

void ConfigStore::SynchronizeRuntime() {
  std::lock_guard<std::mutex> lock(process_mutex_);
  FileLock file_lock(lock_path_);
  runtime_synchronized_ = false;
  NotifyRuntimeLocked(ValidateOrRaise(ReadJson(overlay_path_)));
}

void ConfigStore::AtomicWriteJson(const std::filesystem::path& path, const nlohmann::json& data) {
  WriteDurableFile(path, data.dump(2));
}

AppConfig ConfigStore::SaveOverlay(const nlohmann::json& patch) {
  std::lock_guard<std::mutex> process_lock(process_mutex_);
  FileLock file_lock(lock_path_);

  json current_overlay = ReadJson(overlay_path_);
  json new_overlay = DeepMerge(current_overlay, patch);
  AppConfig cfg = ValidateOrRaise(new_overlay);  // 校验失败在这里抛,磁盘不动
  AtomicWriteJson(overlay_path_, new_overlay);
  try { NotifyRuntimeLocked(cfg); }
  catch (...) { activation_restart_required_ = true; throw; }
  // A later successful write must not hide a previously interrupted application.
  if (activation_restart_required_) throw RuntimeSyncPending();
  return cfg;
}

AppConfig ConfigStore::ReplaceOverlay(const nlohmann::json& new_overlay) {
  std::lock_guard<std::mutex> process_lock(process_mutex_);
  FileLock file_lock(lock_path_);

  AppConfig cfg = ValidateOrRaise(new_overlay);
  AtomicWriteJson(overlay_path_, new_overlay);
  try { NotifyRuntimeLocked(cfg); }
  catch (...) { activation_restart_required_ = true; throw; }
  // A later successful write must not hide a previously interrupted application.
  if (activation_restart_required_) throw RuntimeSyncPending();
  return cfg;
}

}  // namespace ai_service::config

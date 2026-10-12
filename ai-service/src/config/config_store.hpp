// Copyright AINVR. Adapted for the S100P service.
// 配置持久化 —— 对应 Python config_store.py(YAML 基座 + JSON overlay 深
// 合并,原子写回)。详见 docs/v1_parity_design.md §1.3。
//
// - base_path:基座 YAML(config/config.yaml),版本控制/人工编辑,本模块
//   只读不写。
// - overlay_path:运行时 overlay(data/config_overlay.json),gitignore,
//   API 写入只落这里,可能带 server.api_key 明文,0600 权限。
#pragma once

#include <filesystem>
#include <mutex>
#include <string>

#include <nlohmann/json.hpp>

#include "config.hpp"

namespace ai_service::config {

// dict 递归深合并,list/标量整体替换(不逐元素合并)。overlay 出现的 key
// 覆盖 base 同名 key;只有两边都是 object 才递归合并。
nlohmann::json DeepMerge(const nlohmann::json& base, const nlohmann::json& overlay);

// overlay 路径推导规则(必须原样复刻,不能改):
// config路径.parent.parent / "data" / "config_overlay.json"。
std::filesystem::path DeriveOverlayPath(const std::filesystem::path& config_path);

class ConfigStore {
 public:
  ConfigStore(std::filesystem::path base_path, std::filesystem::path overlay_path);

  // base ⊕ overlay 深合并 → AppConfig 全量校验。校验失败抛
  // ConfigValidationError。
  AppConfig Load() const;

  // 仅返回合并后的原始 json,不做结构化校验(只读展示/调试用)。
  nlohmann::json LoadRawMerged() const;

  // 仅返回当前 overlay 内容(不含 base)。
  nlohmann::json LoadOverlayRaw() const;

  // 把 patch 深合并进现有 overlay,校验通过才原子落盘;返回合并后的
  // AppConfig。校验失败:抛 ConfigValidationError,磁盘上的 overlay 文件
  // 一个字节不变(先在内存里 base+新 overlay 校验一遍,通不过直接返回,
  // 不触碰磁盘)。
  AppConfig SaveOverlay(const nlohmann::json& patch);

  // 整体替换 overlay(不与现有 overlay 合并),同样先校验再落盘。
  AppConfig ReplaceOverlay(const nlohmann::json& new_overlay);

 private:
  nlohmann::json ReadMergedRaw() const;
  static nlohmann::json ReadYaml(const std::filesystem::path& path);
  static nlohmann::json ReadJson(const std::filesystem::path& path);
  AppConfig ValidateOrRaise(const nlohmann::json& overlay) const;
  static void AtomicWriteJson(const std::filesystem::path& path, const nlohmann::json& data);

  std::filesystem::path base_path_;
  std::filesystem::path overlay_path_;
  std::filesystem::path lock_path_;
  // 跨进程互斥靠 flock(§1.3);这个 mutex 只防同进程内的并发调用(理论上
  // control_server 的多个请求处理线程可能同时调 SaveOverlay)——两层锁
  // 不冲突,flock 本身可重入安全性由文件句柄的生命周期保证。
  mutable std::mutex process_mutex_;
};

}  // namespace ai_service::config

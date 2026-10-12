// Copyright AINVR. Adapted for the S100P service.
// 配置中心下发配置的应用层 —— 对应 Python config_center_apply.py。
// 边界规则见 docs/v1_parity_design.md §1.4:拒绝 channels 段(唯一写入口
// 是 /api/v1/channels 系列)、拒绝 server.host/port(进程级,绑死在启动
// 时)、未知段/未知 server 字段白名单拒绝。
#pragma once

#include <stdexcept>

#include <nlohmann/json_fwd.hpp>

#include "config.hpp"
#include "config_store.hpp"

namespace ai_service::config {

// 下发配置触碰边界(channels / 部署级字段 / 未知字段),拒绝应用。
class ConfigApplyError : public std::runtime_error {
 public:
  explicit ConfigApplyError(const std::string& msg) : std::runtime_error(msg) {}
};

// 校验边界 -> store.SaveOverlay() 落盘。成功返回合并后的 AppConfig。
// 抛 ConfigApplyError:触碰边界。抛 ConfigValidationError:AppConfig 校验
// 不过。两者都应该让调用方(ConfigCenterClient 的 on_apply 回调)返回
// false/抛异常,客户端会自报 failed 并退避重试。
AppConfig ApplyConfigCenterPatch(ConfigStore& store, const nlohmann::json& patch);

// 判断这次 patch 是否碰到"只在重启后才生效"的 snapshot_store 字段
// (mongo_uri/db_name——ChannelWorker 只在构造时读一次 Mongo 连接,overlay
// 落盘后不会自己重连)。必须在 ApplyConfigCenterPatch 落盘之前调用
// (传入落盘前的旧配置),按值比较而不是"只要出现在 patch 里就算变了"。
bool SnapshotStoreRestartRequired(const AppConfig& old_cfg, const nlohmann::json& patch);

// 只有 SnapshotStoreRestartRequired 为真时才会真的探一次 Mongo 连接
// (ping)——不相关的配置变更/瞬时 Mongo 故障不应该挡住其它字段(比如
// api_key)的更新。连接/鉴权失败抛 ConfigApplyError,不暴露 URI 明文。
void ValidateSnapshotStoreConnection(const AppConfig& old_cfg, const nlohmann::json& patch);

}  // namespace ai_service::config

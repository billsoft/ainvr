// Copyright AINVR. Adapted for the S100P service.
#include "config_center_apply.hpp"

#include <set>

#include <mongoc/mongoc.h>
#include <nlohmann/json.hpp>

namespace ai_service::config {

using nlohmann::json;

namespace {
// 对应 pydantic 的 model_fields 反射——C++ 没有这个能力,手写字段名单,
// 跟 config.hpp 的 AppConfig/ServerConfig 结构体字段保持同步。
const std::set<std::string>& AppConfigFields() {
  static const std::set<std::string> fields = {"server", "snapshot_store", "channels"};
  return fields;
}
const std::set<std::string>& ServerConfigFields() {
  static const std::set<std::string> fields = {"host", "port", "log_level", "api_key"};
  return fields;
}
// 需要重启进程才生效(配置中心第一版直接拒绝)的 server 字段。
const std::set<std::string>& RestartOnlyServerFields() {
  static const std::set<std::string> fields = {"host", "port"};
  return fields;
}
// 接受下发但只在进程重启后才真正生效的 snapshot_store 字段。
// mongo_host/mongo_port 和只读展示账号密码不在这里——ai-service 自己
// 从不读取这几个字段。
const std::set<std::string>& SnapshotStoreRestartOnlyFields() {
  static const std::set<std::string> fields = {"mongo_uri", "db_name"};
  return fields;
}
}  // namespace

AppConfig ApplyConfigCenterPatch(ConfigStore& store, const nlohmann::json& patch) {
  if (!patch.is_object()) {
    throw ConfigApplyError("配置必须是对象");
  }
  if (patch.contains("channels")) {
    throw ConfigApplyError(
        "channels 不允许经配置中心下发:AI 通道的唯一写入口是 AI 通道页 API"
        "(POST/PATCH /api/v1/channels),两个写入口会打架");
  }

  std::vector<std::string> unknown;
  for (auto it = patch.begin(); it != patch.end(); ++it) {
    if (!AppConfigFields().count(it.key())) unknown.push_back(it.key());
  }
  if (!unknown.empty()) {
    std::string joined;
    for (size_t i = 0; i < unknown.size(); ++i) {
      if (i) joined += ", ";
      joined += unknown[i];
    }
    throw ConfigApplyError("未知配置段: " + joined + "(允许: server, snapshot_store, channels 除外)");
  }

  if (patch.contains("server") && patch["server"].is_object()) {
    std::vector<std::string> bad;
    for (auto it = patch["server"].begin(); it != patch["server"].end(); ++it) {
      if (RestartOnlyServerFields().count(it.key())) bad.push_back(it.key());
    }
    if (!bad.empty()) {
      std::string joined;
      for (size_t i = 0; i < bad.size(); ++i) {
        if (i) joined += ",";
        joined += bad[i];
      }
      throw ConfigApplyError("server." + joined +
                             " 是部署级字段(启动时绑死,改了要重启进程),不允许经配置中心下发");
    }
    std::vector<std::string> unknown_server;
    for (auto it = patch["server"].begin(); it != patch["server"].end(); ++it) {
      if (!ServerConfigFields().count(it.key())) unknown_server.push_back(it.key());
    }
    if (!unknown_server.empty()) {
      std::string joined;
      for (size_t i = 0; i < unknown_server.size(); ++i) {
        if (i) joined += ", ";
        joined += unknown_server[i];
      }
      throw ConfigApplyError("server 段未知字段: " + joined);
    }
  }

  return store.SaveOverlay(patch);
}

bool SnapshotStoreRestartRequired(const AppConfig& old_cfg, const nlohmann::json& patch) {
  if (!patch.contains("snapshot_store") || !patch["snapshot_store"].is_object()) return false;
  const auto& sp = patch["snapshot_store"];
  for (auto&& key : SnapshotStoreRestartOnlyFields()) {
    if (!sp.contains(key)) continue;
    std::string new_val = sp[key].get<std::string>();
    std::string old_val = key == "mongo_uri" ? old_cfg.snapshot_store.mongo_uri
                                             : old_cfg.snapshot_store.db_name;
    if (new_val != old_val) return true;
  }
  return false;
}

void ValidateSnapshotStoreConnection(const AppConfig& old_cfg, const nlohmann::json& patch) {
  if (!SnapshotStoreRestartRequired(old_cfg, patch)) return;

  std::string mongo_uri = old_cfg.snapshot_store.mongo_uri;
  std::string db_name = old_cfg.snapshot_store.db_name;
  const auto& sp = patch["snapshot_store"];
  if (sp.contains("mongo_uri")) mongo_uri = sp["mongo_uri"].get<std::string>();
  if (sp.contains("db_name")) db_name = sp["db_name"].get<std::string>();

  bson_error_t error;
  mongoc_uri_t* uri = mongoc_uri_new_with_error(mongo_uri.c_str(), &error);
  if (!uri) {
    throw ConfigApplyError("AI识别历史库连接或鉴权失败,未应用新连接;请检查地址、端口、账号和认证库");
  }
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SERVERSELECTIONTIMEOUTMS, 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_CONNECTTIMEOUTMS, 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SOCKETTIMEOUTMS, 5000);

  mongoc_client_t* client = mongoc_client_new_from_uri(uri);
  mongoc_uri_destroy(uri);
  if (!client) {
    throw ConfigApplyError("AI识别历史库连接或鉴权失败,未应用新连接;请检查地址、端口、账号和认证库");
  }

  bson_t* ping = bson_new_from_json(reinterpret_cast<const uint8_t*>("{\"ping\": 1}"), -1, nullptr);
  bson_t reply;
  bool ok = mongoc_client_command_simple(client, db_name.c_str(), ping, nullptr, &reply, &error);
  bson_destroy(&reply);
  bson_destroy(ping);
  mongoc_client_destroy(client);

  if (!ok) {
    throw ConfigApplyError("AI识别历史库连接或鉴权失败,未应用新连接;请检查地址、端口、账号和认证库");
  }
}

}  // namespace ai_service::config

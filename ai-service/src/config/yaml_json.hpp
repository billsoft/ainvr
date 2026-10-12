// Copyright AINVR. Adapted for the S100P service.
// YAML::Node -> nlohmann::json 转换 —— config.cpp(LoadAppConfig)和
// config_store.cpp(读 YAML 基座)共用,不重复实现。
#pragma once

#include <nlohmann/json_fwd.hpp>
#include <yaml-cpp/yaml.h>

namespace ai_service::config {

nlohmann::json YamlToJson(const YAML::Node& node);

}  // namespace ai_service::config

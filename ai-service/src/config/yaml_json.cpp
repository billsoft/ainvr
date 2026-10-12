// Copyright AINVR. Adapted for the S100P service.
#include "yaml_json.hpp"

#include <nlohmann/json.hpp>

namespace ai_service::config {

nlohmann::json YamlToJson(const YAML::Node& node) {
  using nlohmann::json;
  if (!node || node.IsNull()) return nullptr;
  if (node.IsScalar()) {
    // yaml-cpp 标量总是先当字符串读出来,这里尝试按 bool/int/double 顺序
    // 解析,都失败才当字符串——跟 YAML 1.1 的标量类型推断规则一致。
    const std::string& s = node.Scalar();
    if (s == "true" || s == "True" || s == "TRUE") return true;
    if (s == "false" || s == "False" || s == "FALSE") return false;
    try {
      size_t pos;
      long long i = std::stoll(s, &pos);
      if (pos == s.size()) return i;
    } catch (...) {
    }
    try {
      size_t pos;
      double d = std::stod(s, &pos);
      if (pos == s.size()) return d;
    } catch (...) {
    }
    return s;
  }
  if (node.IsSequence()) {
    json arr = json::array();
    for (auto&& v : node) arr.push_back(YamlToJson(v));
    return arr;
  }
  if (node.IsMap()) {
    json obj = json::object();
    for (auto&& kv : node) obj[kv.first.as<std::string>()] = YamlToJson(kv.second);
    return obj;
  }
  return nullptr;
}

}  // namespace ai_service::config

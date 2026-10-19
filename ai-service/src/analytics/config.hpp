// Copyright AINVR. Strict, versioned analytics configuration.
#pragma once
#include "tracker.hpp"
#include <filesystem>
#include <nlohmann/json.hpp>
namespace ai_service::analytics {
struct ReviewConfig {
  bool enabled=false;
  std::string model_path,description;
  int max_new_tokens=64;
  int timeout_seconds=60;
};
struct NotificationConfig {
  bool enabled=false;
  bool require_review=true;
  std::string endpoint;
};
struct Config {
  NotificationConfig notification;
  ReviewConfig review;
  bool enabled=false;
  bool save_events=true;
  int retention_days=30;
  Options options;
};
inline void Keys(const nlohmann::json& j,const std::set<std::string>& allowed) {
  if(!j.is_object()) throw std::invalid_argument("Analytics configuration must be an object");
  for(auto it=j.begin();it!=j.end();++it)
    if(!allowed.count(it.key())) throw std::invalid_argument("Unknown analytics field: "+it.key());
}
inline double Number(const nlohmann::json& j,const char* key,double fallback) {
  if(!j.contains(key)) return fallback;
  if(!j[key].is_number()) throw std::invalid_argument(std::string("Expected number: ")+key);
  double value=j[key].get<double>();
  if(!std::isfinite(value)) throw std::invalid_argument("Nonfinite analytics number");
  return value;
}
inline int Integer(const nlohmann::json& j,const char* key,int fallback) {
  if(!j.contains(key)) return fallback;
  if(!j[key].is_number_integer()) throw std::invalid_argument(std::string("Expected integer: ")+key);
  auto value=j[key].get<int64_t>();
  if(value<0||value>1000) throw std::invalid_argument("Analytics integer out of range");
  return static_cast<int>(value);
}
inline Config FromJson(const nlohmann::json& j) {
  Config c;
  if(j.is_null()) return c;
  Keys(j,{"save_events","retention_days","enabled","max_gap_seconds","association_distance","line_hysteresis",
          "confirmation_hits","maximum_tracks","rules","review","notification"});
  if(j.contains("enabled")) {
    if(!j["enabled"].is_boolean()) throw std::invalid_argument("analytics.enabled must be boolean");
    c.enabled=j["enabled"].get<bool>();
  }
  if(j.contains("save_events")) {
    if(!j["save_events"].is_boolean())throw std::invalid_argument("save_events must be boolean");
    c.save_events=j["save_events"].get<bool>();
  }
  c.retention_days=Integer(j,"retention_days",30);
  if(c.retention_days<1||c.retention_days>365)throw std::invalid_argument("Retention must be 1 to 365 days");
  if(j.contains("review")) {
    const auto& review=j.at("review");
    Keys(review,{"enabled","model_path","description","max_new_tokens","timeout_seconds"});
    if(review.contains("enabled")&&!review.at("enabled").is_boolean())
      throw std::invalid_argument("review.enabled must be boolean");
    c.review.enabled=review.value("enabled",false);
    c.review.model_path=review.value("model_path",std::string{});
    c.review.description=review.value("description",std::string{});
    c.review.max_new_tokens=Integer(review,"max_new_tokens",64);
    c.review.timeout_seconds=Integer(review,"timeout_seconds",60);
    if(c.review.max_new_tokens<1||c.review.max_new_tokens>256||
       c.review.timeout_seconds<5||c.review.timeout_seconds>300||
       c.review.description.size()>4096||c.review.model_path.size()>4096)
      throw std::invalid_argument("Review bounds are invalid");
    if(c.review.enabled&&(c.review.description.find_first_not_of(" \t\r\n")==std::string::npos||
       c.review.model_path.empty()||std::filesystem::path(c.review.model_path).extension()!=".hbm"))
      throw std::invalid_argument("Review requires an installed HBM path and target description");
    for(const auto& part:std::filesystem::path(c.review.model_path))
      if(part=="..")throw std::invalid_argument("Review model path cannot traverse parent directories");
    if(c.enabled&&c.review.enabled&&!c.save_events)
      throw std::invalid_argument("Review requires event persistence");
  }
  if(j.contains("notification")) {
    const auto& n=j.at("notification");Keys(n,{"enabled","require_review","endpoint"});
    for(const char* key:{"enabled","require_review"})
      if(n.contains(key)&&!n.at(key).is_boolean())throw std::invalid_argument("Notification flags must be boolean");
    c.notification.enabled=n.value("enabled",false);c.notification.require_review=n.value("require_review",true);
    c.notification.endpoint=n.value("endpoint",std::string{});
    const auto& url=c.notification.endpoint;
    if(url.size()>2048||url.find_first_of("\r\n")!=std::string::npos)
      throw std::invalid_argument("Invalid notification endpoint");
    if(c.notification.enabled&&(url.rfind("http://",0)!=0&&url.rfind("https://",0)!=0))
      throw std::invalid_argument("Notification requires an HTTP(S) endpoint");
    if(c.enabled&&c.notification.enabled&&(!c.save_events||(c.notification.require_review&&!c.review.enabled)))
      throw std::invalid_argument("Notification requires persistence and its selected review policy");
  }
  auto& o=c.options;
  o.max_gap_seconds=Number(j,"max_gap_seconds",o.max_gap_seconds);
  o.association_distance=Number(j,"association_distance",o.association_distance);
  o.line_hysteresis=Number(j,"line_hysteresis",o.line_hysteresis);
  o.confirmation_hits=Integer(j,"confirmation_hits",o.confirmation_hits);
  o.maximum_tracks=Integer(j,"maximum_tracks",o.maximum_tracks);
  if(j.contains("rules")) {
    if(!j["rules"].is_array()||j["rules"].size()>64) throw std::invalid_argument("Invalid analytics rules");
    for(const auto& item:j["rules"]) {
      Keys(item,{"id","type","label_id","points","dwell_seconds"});
      Rule r;
      r.id=item.at("id").get<std::string>();
      r.type=item.at("type").get<std::string>();
      r.label=item.value("label_id",std::string{});
      if(r.id.size()>128||r.label.size()>128) throw std::invalid_argument("Analytics ID too long");
      const auto& points=item.at("points");
      if(!points.is_array()||points.size()>32) throw std::invalid_argument("Invalid rule points");
      for(const auto& point:points) {
        if(!point.is_array()||point.size()!=2||!point[0].is_number()||!point[1].is_number())
          throw std::invalid_argument("Expected [x,y] point");
        r.points.push_back({point[0].get<double>(),point[1].get<double>()});
      }
      r.dwell_seconds=Number(item,"dwell_seconds",r.dwell_seconds);
      o.rules.push_back(std::move(r));
    }
  }
  Tracker validated(o);
  return c;
}
inline nlohmann::json ToJson(const Config& c) {
  const auto& o=c.options;
  auto rules=nlohmann::json::array();
  for(const auto& r:o.rules) rules.push_back({{"id",r.id},{"type",r.type},
    {"label_id",r.label},{"points",r.points},{"dwell_seconds",r.dwell_seconds}});
  return {{"notification",{{"enabled",c.notification.enabled},{"require_review",c.notification.require_review},
    {"endpoint",c.notification.endpoint}}},{"review",{{"enabled",c.review.enabled},{"model_path",c.review.model_path},
    {"description",c.review.description},{"max_new_tokens",c.review.max_new_tokens},
    {"timeout_seconds",c.review.timeout_seconds}}},{"save_events",c.save_events},{"retention_days",c.retention_days},{"enabled",c.enabled},{"max_gap_seconds",o.max_gap_seconds},
    {"association_distance",o.association_distance},{"line_hysteresis",o.line_hysteresis},
    {"confirmation_hits",o.confirmation_hits},{"maximum_tracks",o.maximum_tracks},
    {"rules",rules}};
}
// Phase 1 product scope:target tracking and live trails only. Spatial rules,
// stored events, VLM review and notifications are later stages:their stored
// configuration is kept, but nothing of them runs or is queued.
constexpr bool kRulesAndEventsAvailable=false;
constexpr bool kReviewAvailable=false;
constexpr bool kNotificationAvailable=false;

// Capability flags reported by /health:the same switches as the gate.
inline nlohmann::json PhaseCapabilities() {
  return {{"target_tracking",true},{"analytics_rules_events",kRulesAndEventsAvailable},
          {"target_presence_review",kReviewAvailable},{"analytics_notifications",kNotificationAvailable}};
}

// The configuration the service actually runs.
inline Config PhaseEffective(Config c) {
  if(!kRulesAndEventsAvailable) {c.options.rules.clear();c.save_events=false;}
  if(!kReviewAvailable) c.review.enabled=false;
  if(!kNotificationAvailable) c.notification.enabled=false;
  return c;
}

// Which unavailable feature a saved analytics object newly asks for ("" when none).
// Keeping or removing stored values is allowed so tracking edits never drop them.
inline std::string PhaseUnavailableRequest(const nlohmann::json& requested,const nlohmann::json& stored) {
  auto value=[](const nlohmann::json& j,const char* key)->nlohmann::json {
    return j.is_object()&&j.contains(key)?j.at(key):nlohmann::json();
  };
  auto on=[&](const nlohmann::json& j,const char* key) {
    const auto part=value(j,key);return part.is_object()&&part.value("enabled",false)==true;
  };
  if(!kRulesAndEventsAvailable) {
    const auto rules=value(requested,"rules");
    if(rules.is_array()&&!rules.empty()&&rules!=value(stored,"rules")) return "rules";
  }
  if(!kReviewAvailable&&on(requested,"review")&&!on(stored,"review")) return "review";
  if(!kNotificationAvailable&&on(requested,"notification")&&!on(stored,"notification")) return "notification";
  return {};
}
} // namespace ai_service::analytics

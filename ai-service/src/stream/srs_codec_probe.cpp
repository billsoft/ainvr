#include "srs_codec_probe.hpp"

#include <httplib.h>

#include <nlohmann/json.hpp>

namespace ai_service::stream {

namespace {

std::string HostOfHttpBase(const std::string& base) {
  auto p = base.find("://");
  std::string rest = p == std::string::npos ? base : base.substr(p + 3);
  auto end = rest.find_first_of(":/");
  return end == std::string::npos ? rest : rest.substr(0, end);
}

bool IsLoopback(const std::string& host) {
  return host == "127.0.0.1" || host == "localhost" || host == "::1";
}

std::optional<std::string> ReadSrsStreams(const std::string& base, int timeout_ms) {
  try {
    httplib::Client cli(base);
    cli.set_connection_timeout(0, timeout_ms * 1000);
    cli.set_read_timeout(0, timeout_ms * 1000);
    auto res = cli.Get("/api/v1/streams/?count=1000");
    if (res && res->status == 200) return res->body;
  } catch (...) {}
  return std::nullopt;
}

}  // namespace

std::optional<RtmpTarget> ParseRtmpTarget(const std::string& url) {
  auto scheme = url.find("://");
  if (scheme == std::string::npos) return std::nullopt;
  std::string rest = url.substr(scheme + 3);
  auto slash = rest.find('/');
  if (slash == std::string::npos) return std::nullopt;
  RtmpTarget t;
  std::string hostport = rest.substr(0, slash);
  auto colon = hostport.find(':');
  t.host = colon == std::string::npos ? hostport : hostport.substr(0, colon);
  std::string path = rest.substr(slash + 1);
  auto q = path.find('?');
  if (q != std::string::npos) path = path.substr(0, q);
  auto s2 = path.find('/');
  if (s2 == std::string::npos) return std::nullopt;
  t.app = path.substr(0, s2);
  t.stream = path.substr(s2 + 1);
  if (t.stream.size() > 4 && t.stream.compare(t.stream.size() - 4, 4, ".flv") == 0) {
    t.stream.resize(t.stream.size() - 4);
  }
  if (t.host.empty() || t.app.empty() || t.stream.empty() || t.stream.find('/') != std::string::npos) {
    return std::nullopt;
  }
  return t;
}

std::string SrsApiBaseFor(const std::string& stream_url, const std::string& configured_base) {
  auto t = ParseRtmpTarget(stream_url);
  if (!t || IsLoopback(t->host) || t->host == HostOfHttpBase(configured_base)) return configured_base;
  return "http://" + t->host + ":1985";
}

std::optional<VideoCodec> CodecFromSrsStreamsJson(const std::string& body, const std::string& app,
                                                  const std::string& stream) {
  auto j = nlohmann::json::parse(body, nullptr, false);
  if (j.is_discarded() || !j.contains("streams") || !j["streams"].is_array()) return std::nullopt;
  for (const auto& s : j["streams"]) {
    if (!s.is_object() || s.value("app", "") != app || s.value("name", "") != stream) continue;
    if (!s.contains("video") || !s["video"].is_object()) return std::nullopt;
    return ParseCodecName(s["video"].value("codec", ""));
  }
  return std::nullopt;
}

std::optional<VideoCodec> QuerySrsStreamCodec(const std::string& srs_api_base, const std::string& stream_url,
                                              int timeout_ms) {
  auto t = ParseRtmpTarget(stream_url);
  if (!t) return std::nullopt;
  auto body = ReadSrsStreams(SrsApiBaseFor(stream_url, srs_api_base), timeout_ms);
  return body ? CodecFromSrsStreamsJson(*body, t->app, t->stream) : std::nullopt;
}

std::optional<SrsVideoProgress> VideoProgressFromSrsStreamsJson(
    const std::string& body, const std::string& app, const std::string& stream) {
  try {
    auto j = nlohmann::json::parse(body);
    if (!j.contains("streams") || !j["streams"].is_array()) return std::nullopt;
    for (const auto& s : j["streams"]) {
      if (!s.is_object() || s.value("app", "") != app || s.value("name", "") != stream) continue;
      const auto& pub = s.at("publish");
      if (!pub.value("active", false) || !s.at("frames").is_number_integer()) return std::nullopt;
      const auto frames = s.at("frames").get<int64_t>();
      const auto publisher = pub.value("cid", "");
      if (frames <= 0 || publisher.empty()) return std::nullopt;
      return SrsVideoProgress{publisher, frames};
    }
  } catch (...) {}
  return std::nullopt;
}

std::optional<SrsVideoProgress> QuerySrsVideoProgress(const std::string& srs_api_base,
    const std::string& stream_url, int timeout_ms) {
  auto t = ParseRtmpTarget(stream_url);
  if (!t) return std::nullopt;
  auto body = ReadSrsStreams(SrsApiBaseFor(stream_url, srs_api_base), timeout_ms);
  return body ? VideoProgressFromSrsStreamsJson(*body, t->app, t->stream) : std::nullopt;
}

}  // namespace ai_service::stream

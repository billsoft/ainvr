// 向 SRS 查源流编码(/api/v1/streams 的 video.codec,265 实测为 "HEVC"),供拉流
// 管线建管线前选 264/265 分支(设计 D7、§6.1)。纯函数部分单测,网络部分薄封装。
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <cstdint>

#include "video_codec.hpp"

namespace ai_service::stream {

// rtmp://host[:port]/app/stream[?q] → {host, app, stream};解析失败返回 nullopt
struct RtmpTarget {
  std::string host;
  std::string app;
  std::string stream;
};
struct SrsVideoProgress {
  std::string publisher;
  int64_t frames = 0;
};
std::optional<SrsVideoProgress> VideoProgressFromSrsStreamsJson(
    const std::string& body, const std::string& app, const std::string& stream);
std::optional<SrsVideoProgress> QuerySrsVideoProgress(const std::string& srs_api_base,
    const std::string& stream_url, int timeout_ms = 1000);
std::optional<RtmpTarget> ParseRtmpTarget(const std::string& url);

// 源在本机(回环地址)或与配置的 SRS API 同主机时用配置值;否则按源主机 :1985
std::string SrsApiBaseFor(const std::string& stream_url, const std::string& configured_base);

// 从 /api/v1/streams 的响应里找 app/stream 的 video.codec
std::optional<VideoCodec> CodecFromSrsStreamsJson(const std::string& body, const std::string& app,
                                                  const std::string& stream);

// 查一次(超时 timeout_ms);网络失败/流不在线返回 nullopt
std::optional<VideoCodec> QuerySrsStreamCodec(const std::string& srs_api_base, const std::string& stream_url,
                                              int timeout_ms = 1000);

}  // namespace ai_service::stream

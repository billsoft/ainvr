#include "log.hpp"
#include "warning_log.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <memory>
#include <regex>

#include <nlohmann/json.hpp>

namespace ai_service::log {

namespace {

std::atomic<int> g_level{static_cast<int>(Level::kInfo)};
std::mutex g_write_mutex;
std::unique_ptr<WarningLog> g_warning_log;
std::atomic<uint64_t> g_warning_file_failures{0};

const char* LevelName(Level level) {
  switch (level) {
    case Level::kDebug: return "DEBUG";
    case Level::kInfo: return "INFO";
    case Level::kWarning: return "WARNING";
    case Level::kError: return "ERROR";
  }
  return "INFO";
}

// 截到不超过 max_bytes 的最近一个 UTF-8 字符边界。
std::string TruncateUtf8(const std::string& s, size_t max_bytes) {
  if (s.size() <= max_bytes) return s;
  size_t cut = max_bytes;
  while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) --cut;
  return s.substr(0, cut);
}

}  // namespace

void SetLevel(const std::string& name) {
  if (name == "debug") g_level.store(static_cast<int>(Level::kDebug));
  else if (name == "info") g_level.store(static_cast<int>(Level::kInfo));
  else if (name == "warning") g_level.store(static_cast<int>(Level::kWarning));
  else if (name == "error") g_level.store(static_cast<int>(Level::kError));
}

void EnableWarningFileLog(const std::string& directory) {
  std::lock_guard<std::mutex> lock(g_write_mutex);
  g_warning_log=std::make_unique<WarningLog>(directory);
}
uint64_t WarningFileFailures(){return g_warning_file_failures.load();}

bool Enabled(Level level) { return static_cast<int>(level) >= g_level.load(); }

std::string Redact(const std::string& text) {
  // 三条规则与 ainvr_logging.safe() 逐条对应,顺序也一致。
  static const std::regex kBearer(R"(\bBearer\s+[^\s,;"}]+)", std::regex::icase);
  static const std::regex kUriCred(R"(([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@)",
                                   std::regex::icase);
  static const std::regex kKeyValue(
      R"(((?:password|passwd|secret|token|authorization|api[_-]?key)["\s]*[:=]["\s]*)([^\s,;}]+))",
      std::regex::icase);
  std::string out = std::regex_replace(text, kBearer, "Bearer [REDACTED]");
  out = std::regex_replace(out, kUriCred, "$1[REDACTED]@");
  out = std::regex_replace(out, kKeyValue, "$1[REDACTED]");
  return TruncateUtf8(out, 8192);
}

std::string FormatEvent(Level level, const std::string& module, const std::string& message,
                        int64_t ts_ms) {
  nlohmann::ordered_json j;
  j["ts"] = ts_ms;
  j["level"] = LevelName(level);
  j["module"] = module;
  j["category"] = "runtime";
  j["message"] = Redact(message);
  j["count"] = 1;
  // 上游字符串可能夹带非法 UTF-8(GStreamer/TensorRT 的原生错误文本),
  // 默认 strict 模式会直接抛异常——日志路径绝不能因为一条日志把调用方打崩。
  return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
}

void Write(Level level, const std::string& module, const std::string& message) {
  if (!Enabled(level)) return;
  int64_t ts_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
  std::string line = FormatEvent(level, module, message, ts_ms);
  std::lock_guard<std::mutex> lock(g_write_mutex);
  std::cerr << line << '\n';
  std::cerr.flush();
  if(g_warning_log&&level>=Level::kWarning){
    try{g_warning_log->Append(line);}
    catch(...){
      // Keep the original stderr event even if the diagnostic SSD is unhealthy.
      if(g_warning_file_failures.fetch_add(1)==0)
        std::cerr<<"AINVR private warning log unavailable; inspect health counter\n";
    }
  }
}

}  // namespace ai_service::log

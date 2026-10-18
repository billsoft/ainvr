// 统一日志 —— 对应 Python utils/logger.py + 仓库共享的 shared/ainvr_logging.py。
//
// 每条日志是一行 JSON 事件,字段与 ainvr_logging.EventFormatter 完全一致:
// {ts(毫秒), level, module, category:"runtime", message, count}——全仓库
// 各服务同一套事件形状,可观测性采集器(host-restart-helper/observability.py
// ::ingest)按 JSON 解析即可,不用为 C++ 版单独写一套行格式正则。
// message 落盘前按 ainvr_logging.safe() 同款规则脱敏(URI 里的
// user:password@、Bearer 令牌、password/token/api_key=... 形式的键值)。
//
// 级别门控读 server.log_level(debug/info/warning/error)——该字段在配置
// 校验里是强制枚举,如果这里不消费它,就又是一个"校验了但没人用"的死字段。
#pragma once

#include <cstdint>
#include <sstream>
#include <string>

namespace ai_service::log {

enum class Level { kDebug = 10, kInfo = 20, kWarning = 30, kError = 40 };

// name 取 server.log_level 的合法值;未知值保持当前级别不变(配置校验已
// 在更早的位置拒绝非法值,这里不重复报错)。
void SetLevel(const std::string& name);
// Two private 4 MiB files on SSD, independent of noisy kernel journal rotation.
// Only already-redacted structured warnings/errors are copied.
void EnableWarningFileLog(const std::string& directory);
uint64_t WarningFileFailures();
bool Enabled(Level level);

// ainvr_logging.safe() 的 C++ 版:脱敏 + 截断到 8192 字节(按 UTF-8 字符
// 边界截,不会切出半个汉字)。
std::string Redact(const std::string& text);

// 生成一行事件 JSON(不含换行)。拆出来单独暴露是为了能在单测里直接
// 断言字段,不用去抓 stderr。
std::string FormatEvent(Level level, const std::string& module, const std::string& message,
                        int64_t ts_ms);

// 级别不够时直接返回;够的话加锁写一行到 stderr(systemd unit 把 stdout/
// stderr 都 append 到 logs/ai_service.log)。
void Write(Level level, const std::string& module, const std::string& message);

inline void Debug(const std::string& module, const std::string& msg) {
  Write(Level::kDebug, module, msg);
}
inline void Info(const std::string& module, const std::string& msg) {
  Write(Level::kInfo, module, msg);
}
inline void Warning(const std::string& module, const std::string& msg) {
  Write(Level::kWarning, module, msg);
}
inline void Error(const std::string& module, const std::string& msg) {
  Write(Level::kError, module, msg);
}

}  // namespace ai_service::log

// 流式拼接版:AI_LOG(kWarning, "ai-service.publisher", "[" << id << "] 耗时 " << ms);
// 级别不够时连字符串都不拼。
#define AI_LOG(level_enum, module, stream_expr)                                  \
  do {                                                                           \
    if (::ai_service::log::Enabled(::ai_service::log::Level::level_enum)) {      \
      std::ostringstream ai_log_os_;                                             \
      ai_log_os_ << stream_expr;                                                 \
      ::ai_service::log::Write(::ai_service::log::Level::level_enum, (module),   \
                               ai_log_os_.str());                                \
    }                                                                            \
  } while (0)

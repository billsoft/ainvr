#pragma once
#include "snapshot_store.hpp"
#include <filesystem>
#include <fstream>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <mutex>
#include <random>
#include <sstream>
#include <stdexcept>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "../utils/log.hpp"
#include "archive_executor.hpp"
#include "archive_batch.hpp"


// Internal implementation contracts; not part of the HTTP or plugin API.
namespace ai_service::output {
struct CapturedSnapshotFrame {
  cv::Mat rgba;
  std::function<void()> release;
  ~CapturedSnapshotFrame() {
    rgba.release();
    if (release) release();
  }
};

namespace snapshot_detail {


inline void LogPreparationFailure(const std::string& channel, std::exception_ptr error,
                           const char* context) noexcept {
  if (!error) return;
  // Even reporting an allocation failure must not escape the writer thread.
  try {
    std::string detail;
    try { std::rethrow_exception(error); }
    catch (const std::exception& e) { detail = e.what(); }
    catch (...) { detail = "non-standard exception"; }
    log::Error("ai-service.snapshot", "[" + channel + "] CRITICAL " + context + ": " + detail);
  } catch (...) {}
}

struct CaptureBudget {
  std::mutex mutex;
  std::condition_variable changed;
};
inline CaptureBudget& Captures() { static CaptureBudget budget; return budget; }

inline std::shared_ptr<CapturedSnapshotFrame> ReserveFrame(
    const std::shared_ptr<ArchiveCapacity>& capacity,
    const std::shared_ptr<std::atomic<size_t>>& channel_frames,
    const std::function<bool()>& cancelled, std::atomic<bool>& backpressured) {
  auto& budget = Captures();
  std::unique_lock<std::mutex> lock(budget.mutex);
  while (channel_frames->load() >= 2) {
    if (cancelled()) { backpressured.store(false); return {}; }
    backpressured.store(true);
    budget.changed.wait_for(lock, std::chrono::milliseconds(100));
  }
  auto frame = std::make_shared<CapturedSnapshotFrame>();
  frame->release = [capacity, channel_frames] {
    auto& budget = Captures();
    { std::lock_guard<std::mutex> lock(budget.mutex);
      channel_frames->fetch_sub(1); }
    budget.changed.notify_all();
  };
  channel_frames->fetch_add(1);
  backpressured.store(false);
  return frame;
}

using nlohmann::json;

constexpr const char* kLogModule = "ai-service.snapshot";

// 拼 Mongo 查询 JSON 时,数值/字符串一律经 nlohmann 序列化:
// - double:往返无损精度。ostream 默认只有 6 位有效数字,Unix 秒时间戳
//   1790168716 会被写成 1.79017e+09,范围查询/删除被取整到 ~1 万秒粒度
//   (2026-09-23 生产事故:识别历史"最近 10 分钟"查不到)。
// - 字符串:带引号转义,image_id/cursor 里的引号不能拼坏查询结构。
inline std::string JsonNum(double v) { return json(v).dump(); }
inline std::string JsonStr(const std::string& s) { return json(s).dump(); }

// {"$gte": from, "$lte": to},只含给了的那一端。
inline std::string TsRangeJson(std::optional<double> from_ts, std::optional<double> to_ts) {
  std::string out = "{";
  if (from_ts.has_value()) out += "\"$gte\": " + JsonNum(*from_ts);
  if (to_ts.has_value()) {
    if (from_ts.has_value()) out += ", ";
    out += "\"$lte\": " + JsonNum(*to_ts);
  }
  return out + "}";
}

// 列表接口的对外契约 = v1 SnapshotStore._doc_to_list_item:固定的扁平字段,
// 尺寸放顶层 image_width/image_height;image 子对象、enhance_model、
// brightness_corrected、embedding 这些内部存储字段不透传。
inline json DocToListItem(const json& doc) {
  auto get = [&](const char* k) { return doc.contains(k) ? doc[k] : json(nullptr); };
  json image = doc.contains("image") && doc["image"].is_object() ? doc["image"] : json::object();
  json item{
      {"image_id", get("image_id")},
      {"channel_id", get("channel_id")},
      {"channel_name", get("channel_name")},
      {"frame_pts_ns", get("frame_pts_ns")},
      {"timestamp", get("timestamp")},
      {"model_name", get("model_name")},
      {"task_type", get("task_type")},
      {"class_id", get("class_id")},
      {"class_name", get("class_name")},
      {"confidence", get("confidence")},
      {"bbox", get("bbox")},
      {"landmarks", get("landmarks")},
      {"image_width", image.contains("width") ? image["width"] : json(nullptr)},
      {"image_height", image.contains("height") ? image["height"] : json(nullptr)},
      {"enhanced", doc.contains("enhanced") && doc["enhanced"].is_boolean() && doc["enhanced"].get<bool>()},
  };
  for (const auto* key : {"label_id", "query_description", "model_extra"})
    if (doc.contains(key)) item[key] = doc[key];
  return item;
}

// 本地图像编码失败不等于数据库断线：保留当前任务并单独重试。
class CropBatchBudgetError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class SnapshotEncodeError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

inline bool IsObjectIdHex(const std::string& s) {
  return s.size() == 24 && std::all_of(s.begin(), s.end(), [](unsigned char c) {
           return std::isxdigit(c) != 0;
         });
}

// 超采样系数(ERP 通道)——见 erp_perspective.hpp/移植设计文档 §3.4。
constexpr double kErpSupersampleFactor = 1.5;
constexpr double kReconnectInitialSeconds = 5.0;
constexpr double kReconnectMaxSeconds = 300.0;
constexpr double kReconnectBackoffFactor = 2.0;

inline double NowMono() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

inline std::once_flag g_mongoc_init_once;
// mongoc_init() 全局只调一次(多个通道各自的 SnapshotStore 共享同一个
// mongoc 库状态)。故意不调 mongoc_cleanup()——理由跟 face_enhancer.cpp
// 的单例处理一致:进程退出时的全局清理顺序不可控,不如不清理,让 OS 直接
// 回收。
inline void EnsureMongocInit() {
  std::call_once(g_mongoc_init_once, [] { mongoc_init(); });
}

// mongoc_client_t 不是线程安全的,每次操作从 pool 里借一个用完即还。
class PooledClient {
 public:
  explicit PooledClient(mongoc_client_pool_t* pool) : pool_(pool), client_(mongoc_client_pool_pop(pool)) {}
  ~PooledClient() {
    if (client_) mongoc_client_pool_push(pool_, client_);
  }
  PooledClient(const PooledClient&) = delete;
  PooledClient& operator=(const PooledClient&) = delete;
  mongoc_client_t* get() const { return client_; }

 private:
  mongoc_client_pool_t* pool_;
  mongoc_client_t* client_;
};

// RAII 封装 mongoc_collection_t。
class ScopedCollection {
 public:
  ScopedCollection(mongoc_client_t* client, const std::string& db, const std::string& name)
      : coll_(mongoc_client_get_collection(client, db.c_str(), name.c_str())) {}
  ~ScopedCollection() {
    if (coll_) mongoc_collection_destroy(coll_);
  }
  ScopedCollection(const ScopedCollection&) = delete;
  ScopedCollection& operator=(const ScopedCollection&) = delete;
  mongoc_collection_t* get() const { return coll_; }

 private:
  mongoc_collection_t* coll_;
};

inline std::string BsonErrorMessage(const bson_error_t& err) { return std::string(err.message); }

// Python 内置 round() 是银行家舍入(round-half-to-even),std::lround 是
// 远离零舍入——.5 边界会差 1(erp_perspective.cpp 已经实测踩过这个坑,
// 这里同样的裁剪尺寸计算重复一份,不引入跨模块共享头文件)。
inline double PyRound(double x) { return std::nearbyint(x); }

void TrimHistory(mongoc_collection_t*, int64_t, std::optional<int64_t>&);
}
}

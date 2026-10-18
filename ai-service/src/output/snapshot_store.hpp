// 识别快照归档 —— 对应 Python output/snapshot_store.py。详见
// docs/v1_parity_design.md §1.5/§3.5。
//
// 逐帧归档(min_interval_ms=0)：有界队列满时背压，数据库失败保留任务重试。
//   - 逐帧模式优先捕获独立 RGBA 帧(每通道两帧、全局 384 MiB)，共享
//     四线程处理裁剪/亮度/增强/JPEG；不把解码池帧交给后台线程。
//   - 超出异步支持范围时保留同步区域裁剪；队列/捕获预算满时反压。
//   - 每通道写入线程批量写 Mongo 并滚动 trim；原始和处理图同文档删除。
//   - 正常停机的待写任务保存到 pending_dir，启动后恢复；断电前的内存任务
//     不具备持久性，只有 Mongo 确认或 pending 文件落盘才算已保存。
//
// Mongo 客户端用 libmongoc(C API,§1.6 已确认 apt 可装),不是 mongocxx。
#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include <mongoc/mongoc.h>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>

#include "../config/config.hpp"
#include "../pipeline/snapshot_sink.hpp"
#include "erp_perspective.hpp"
#include "result.hpp"
#include "history_deletions.hpp"
#include "archive_capacity.hpp"

namespace ainvr { class GlesCropBackend; }
namespace ai_service::output {

struct CapturedSnapshotFrame;

// 裁剪 bbox 外扩 padding_ratio 后的区域;画面边缘处自动收窄,不越界、不
// 环绕。结果最长边超过 max_dimension 时等比缩小(INTER_AREA)。bbox 退化
// (宽高<=0)或裁剪区域为空时返回空 Mat,调用方应跳过这个检测框。
// keep_square=true:以 bbox 中心为不动点取正方形裁剪,框扩出画面的部分用
// 边缘像素 replicate 补齐,保证入库截图严格正方形。
cv::Mat CropWithPadding(const cv::Mat& frame_rgba, const std::array<double, 4>& bbox,
                        double padding_ratio, int max_dimension, bool keep_square = false);

// RFC 4122 v4 UUID(小写,8-4-4-4-12)。image_id 的外部契约是 uuid4
// (§1.5;v1 用 str(uuid.uuid4())),新旧文档共存于同一批集合,格式必须一致。
std::string NewUuid4();

// 单个生产者拥有；ERP 坐标与采样算法保持不变，下载区域是所有目标的并集。
// 普通裁剪及预算超出的 ERP 计划使用复用的整帧缓冲兜底。
class SnapshotCropper {
 public:
  explicit SnapshotCropper(bool exact_views=false):exact_views_(exact_views) {}
  std::vector<cv::Mat> Crop(const pipeline::SnapshotSink::FrameProvider& frame,
                            const std::vector<Detection>& detections, bool square,
                            const config::SnapshotConfig& cfg);
  size_t downloaded_bytes() const { return downloaded_bytes_; }
  double download_ms() const { return download_ms_; }
  bool full_frame() const { return full_frame_; }
  size_t invalid_count() const { return invalid_count_; }
 private:
  bool exact_views_;
  ErpMapCache maps_;
  std::shared_ptr<ainvr::GlesCropBackend> gpu_;
  cv::Mat host_;
  size_t downloaded_bytes_ = 0;
  double download_ms_ = 0;
  bool full_frame_ = false;
  size_t invalid_count_ = 0;
};

class SnapshotUnavailable : public std::runtime_error {
 public:
  SnapshotUnavailable() : std::runtime_error("识别归档暂不可用，请检查数据库连接后重试") {}
};

class SnapshotStore : public pipeline::SnapshotSink {
 public:
  SnapshotStore(config::SnapshotConfig initial_cfg, std::string mongo_uri, std::string db_name,
                std::string channel_id, std::string channel_name,
                std::string face_enhance_engine_path,
                std::string face_enhance_codeformer_engine_path, size_t queue_maxsize = 64,
                bool preload_face_enhancer = true, std::string pending_dir = "");
  ~SnapshotStore() override;

  SnapshotStore(const SnapshotStore&) = delete;
  SnapshotStore& operator=(const SnapshotStore&) = delete;

  // Keep history readable and drain previously accepted jobs while capture is off.
  void Start(bool keep_history_access = false);
  void Stop();
  // Stop/join only the writer; readers may still hold this store's shared_ptr.
  void QuiesceWriter();
  void RequestStop();
  // Deletes only snapshots_<id>, including embedded image bytes and indexes.
  // Independent connection also covers currently disabled archive channels.
  static void DropChannelHistory(const config::SnapshotStoreConfig& config,
                                 const std::string& channel_id);
  static void DeletePending(const std::string& channel_id);
  static std::string PendingDirectory(const std::string& channel_id);

  // pipeline::SnapshotSink —— 推理线程调用(热路径)。
  void Offer(const FrameProvider& frame_provider, const std::string& channel_id,
             const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
             const std::string& model_name, const std::string& task_type,
             const std::vector<Detection>& crop_detections,
             const std::vector<Detection>& stored_detections, bool square_crop,
             const config::SnapshotConfig& snapshot_cfg) override;
  void OfferResult(const FrameProvider& frame_provider, const FrameResult& result,
                   const std::string& channel_name,
                   const std::vector<Detection>& crop_detections, bool square_crop,
                   const config::SnapshotConfig& snapshot_cfg) override;

  // 热更新入口:对应 v1 apply_hot_patch 里的 `self._snapshot_store.cfg =
  // new_cfg.snapshot`。只靠 Offer 带配置的话,热改 max_count 要等到下一次
  // 有检测结果的帧才生效——期间 trim 和概览里的 max_count 都还是旧值。
  void UpdateConfig(const config::SnapshotConfig& cfg);
  void WaitForCapacity(const std::function<bool()>& cancelled) override;
  void ReserveForFrame(cv::Size size) override;

  // ---- 管理 API(同步调用,control_server 负责扔线程池,这里不关心) ----
  nlohmann::json GetOverview() const;
  nlohmann::json ListPage(std::optional<std::string> cursor, int limit, double min_confidence,
                          std::optional<double> from_ts, std::optional<double> to_ts) const;
  nlohmann::json Heatmap(std::optional<double> from_ts, std::optional<double> to_ts,
                         int bucket_s) const;
  std::optional<std::vector<uint8_t>> GetImage(const std::string& image_id, bool original = false) const;
  bool DeleteOne(const std::string& image_id);
  int64_t DeleteRange(double from_ts, double to_ts);
  int64_t Clear();

  nlohmann::json GetStats() const;

 private:
  friend struct SnapshotStoreTestAccess;
  struct ArchiveJob {
    uint64_t archive_epoch = 0;
    bson_oid_t oid;
    std::string image_id;
    std::string channel_id;
    std::string channel_name;
    int64_t frame_pts_ns;
    double timestamp;
    std::string model_name;
    std::string task_type;
    Detection detection;  // stored 坐标(rescale 之后)
    // A point record has no detection bbox. crop_detection is only the internal
    // full-frame context image ROI, never reported as a detected object.
    nlohmann::json point = nullptr;
    cv::Mat crop;          // RGBA
    std::shared_ptr<CapturedSnapshotFrame> frame;
    Detection crop_detection;
    bool square = false;
    std::optional<config::SnapshotConfig> config;
    std::vector<uint8_t> jpeg, original_jpeg;
    int image_width = 0, image_height = 0;
    bool enhanced = false, brightness_applied = false;
    std::string enhance_model;
  };

  void WriterLoop();
  void OfferTargets(const FrameProvider& frame_provider, const std::string& channel_id,
                    const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
                    const std::string& model_name, const std::string& task_type,
                    const std::vector<Detection>& crop_detections,
                    const std::vector<Detection>& stored_detections, bool square_crop,
                    const config::SnapshotConfig& snapshot_cfg,
                    const std::vector<nlohmann::json>& points);
  void SpoolLoop();
  void RemovePending(const std::string& image_id);
  void PrepareNextBatch(std::vector<ArchiveJob>& batch, size_t limit);
  void PrepareBatch(std::vector<ArchiveJob>& jobs);
  void WriteBatch(std::vector<ArchiveJob>& jobs);
  void MaterializeCrop(ArchiveJob& job);
  void PrepareImage(ArchiveJob& job);
  void AppendWrite(mongoc_bulk_operation_t* bulk, const ArchiveJob& job);
  bool TryConnect(bool ensure_indexes = true);
  int64_t ApplyDeletionRules(mongoc_collection_t* collection);
  int64_t DeleteHistory(nlohmann::json filter);
  HistoryDeletions deletions_;
  uint64_t applied_deletion_epoch_ = 0;  // history_mutex_; replay once per store lifetime
  void ScheduleReconnect();
  void SavePending(const ArchiveJob& job, bool enqueue = true);
  void PreservePending(const ArchiveJob& job) noexcept;
  void QuarantineJob(const ArchiveJob& job, const std::string& reason);
  void QuarantinePending(const std::string& file);
  void Track(const std::string& id, const std::string& stage);
  void Finish(const std::string& id, const std::string& outcome);
  mutable std::mutex ledger_mutex_;
  struct TrackedJob { std::string stage; double since; };
  std::map<std::string, TrackedJob> outstanding_;
  uint64_t accepted_targets_ = 0, committed_targets_ = 0;
  // Admission to Mongo acknowledgement; monotonic, excludes pre-admission work.
  double committed_latency_sum_ms_ = 0, committed_latency_max_ms_ = 0;
  std::deque<double> recent_committed_latency_ms_;
  uint64_t quarantined_targets_ = 0, deleted_targets_ = 0;
  void SetArchiveFault(const std::string& stage, const std::string& message);
  void ClearArchiveFault(const std::string& stage);
  mutable std::mutex fault_mutex_;
  struct ArchiveFault { std::string message; double since; };
  std::map<std::string, ArchiveFault> archive_faults_;
  void LoadPending();
  ArchiveJob ReadPending(const std::string& file);
  std::deque<std::string> pending_files_;
  std::string pending_dir_;
  mutable std::mutex pending_io_mutex_;
  std::map<std::string, uintmax_t> pending_sizes_;
  // Statistics must not wait for durable disk IO. Writer bookkeeping stays locked.
  std::atomic<uintmax_t> pending_bytes_{0};
  std::atomic<uintmax_t> quarantined_bytes_{0};
  std::atomic<uint64_t> spooled_count_{0};
  std::atomic<bool> spool_blocked_{false};
  std::atomic<bool> backpressured_{false};
  std::atomic<size_t> preparing_targets_{0};
  std::atomic<size_t> prepared_ahead_targets_{0};

  config::SnapshotConfig cfg_;  // Hot configuration; accepted jobs retain their own copy.
  mutable std::mutex cfg_mutex_;
  // Serialize history mutations so the exact retained count can be maintained
  // from Mongo acknowledgements; API deletes invalidate it before mutation.
  mutable std::mutex history_mutex_;
  std::optional<int64_t> history_count_;
  std::string mongo_uri_;
  std::string db_name_;
  std::string channel_id_;
  std::string channel_name_;
  std::string face_enhance_engine_path_;
  std::string face_enhance_codeformer_engine_path_;
  size_t queue_maxsize_;
  // Start() 时是否预加载人脸增强 engine(只为提前在日志暴露缺失/初始化
  // 失败);非人脸通道预加载只是白占显存。写入时仍按需懒加载。
  bool preload_face_enhancer_;

  std::thread thread_;
  std::thread spool_thread_;
  std::atomic<bool> stop_event_{false};
  std::atomic<bool> capture_enabled_{false};
  std::atomic<bool> trim_requested_{false};
  std::atomic<uint64_t> capture_epoch_{0};
  std::atomic<bool> writer_running_{false};
  std::mutex join_mutex_;

  // mongoc_client_t 不是线程安全的,不能被写入线程和 HTTP 查询线程共享
  // 同一个实例——用 mongoc_client_pool_t(线程安全连接池)代替单个
  // client,每次操作各自 pop/push 一个临时 client(见 .cpp 里的
  // PooledClient RAII 封装)。pool_ 本身的创建/销毁只在 Start()/Stop()
  // 做一次,不需要额外加锁。
  mongoc_uri_t* uri_ = nullptr;
  mongoc_client_pool_t* pool_ = nullptr;
  std::string collection_name_;
  // mutable:GetOverview/ListPage 等只读查询方法里,发现连接失败也要能
  // 标记断线+记录错误(跟 v1 语义一致——查询失败本身就是判断"连接是否还
  // 活着"的信号来源之一,不只是写入线程才会发现断线)。
  mutable std::atomic<bool> connected_{false};  // 至少成功 ping 通过一次
  mutable std::mutex connect_mutex_;  // 保护 last_connect_error_/reconnect_delay_s_
  mutable std::optional<std::string> last_connect_error_;
  double reconnect_delay_s_ = 5.0;

  std::shared_ptr<ArchiveCapacity> capacity_ =
      std::make_shared<ArchiveCapacity>(ArchiveCapacity::SharedPool());

  std::mutex offer_mutex_;  // serialize producers; writer only removes queue entries
  SnapshotCropper cropper_;
  std::shared_ptr<std::atomic<size_t>> captured_frames_ = std::make_shared<std::atomic<size_t>>(0);
  double last_crop_stats_log_mono_ = 0;
  double last_crop_failure_log_mono_ = 0;

  mutable std::mutex queue_mutex_;
  std::condition_variable queue_cond_;
  std::deque<ArchiveJob> queue_;

  mutable std::mutex stats_mutex_;
  int64_t enqueued_count_ = 0;
  int64_t dropped_count_ = 0;
  int64_t written_count_ = 0;
  int64_t mongo_write_batches_ = 0;
  int64_t write_error_count_ = 0;
  int64_t enhanced_count_ = 0;
  int64_t enhance_error_count_ = 0;
  int64_t brightness_count_ = 0;
  int64_t brightness_error_count_ = 0;
  int64_t crop_error_count_ = 0;
  int64_t crop_failed_count_ = 0;  // targets lost to a failed crop batch
  int64_t invalid_crop_count_ = 0;
  int64_t crop_batches_ = 0;
  size_t last_download_bytes_ = 0;
  double last_download_ms_ = 0;
  double last_crop_ms_ = 0;
  double last_prepare_ms_ = 0;
  double last_mongo_ms_ = 0;
  double mongo_max_ms_ = 0;
  double last_history_wait_ms_ = 0;
  int64_t mongo_slow_batches_ = 0;
  int64_t captured_count_ = 0;
  int64_t prepared_count_ = 0;
  double crop_processing_ms_ = 0, brightness_ms_ = 0, enhancement_ms_ = 0, encoding_ms_ = 0;
  double last_trim_ms_ = 0;
};

}  // namespace ai_service::output

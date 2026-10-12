// StreamPublisher —— 对应 Python stream/publisher.py。
#pragma once

#include <atomic>
#include <mutex>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include "au_buffer.hpp"
#include "reconnect.hpp"
#include "video_codec.hpp"

typedef struct _GstElement GstElement;
typedef struct _GstBus GstBus;
typedef struct _GstPipeline GstPipeline;

namespace ai_service::stream {

// 把源流时间戳重映射到"本条发布管线自己的时间轴(从 0 开始)"。
//
// ⚠️ 这不是锦上添花的规整,是发布管线能否推出数据的硬前提——2026-09-17
// 生产事故根因:发布管线重建时 base_time 从 0 开始,源 PTS 若已经涨到几
// 千秒且原样复制进去,rtmp2sink(sync=true)会认为第一帧的播放时刻在几
// 千秒之后,一个字节都不发,直到自己超时、重建、再等,形成永不收敛的
// 重连风暴(生产上跑到过第 190 次)。
//
// ⚠️⚠️ 帧间隔必须按 DTS 算,绝不能按 PTS——第一版修复就栽在这里:本机
// 源流是 IBBPBBP 结构,解码顺序下 PTS 天然非单调(显示序 I0 B1 B2 P3 的
// 解码序是 I0 P3 B1 B2,PTS 走 0→3→1→2)。按 PTS 算帧间隔,每 3 帧就有
// 1 次"负增量"被误判成时间轴不连续,输出时间轴因此跑得比真实时间快,
// rtmp2sink 按时间戳节流,吞吐被压到源速率的一半,发不出去的帧堆在
// appsrc 队列里无上限增长。DTS 在解码顺序下天然单调,是唯一能用来算
// 帧间隔的量;PTS 用 DTS 加上原本的重排偏移(src_pts - src_dts)带过去。
//
// 纯逻辑、与 GStreamer 解耦,可确定性单测。
class PtsRebaser {
 public:
  static constexpr int64_t kDiscontinuityNs = 10LL * 1'000'000'000;
  static constexpr int64_t kDefaultStepNs = 33'333'333;

  explicit PtsRebaser(int64_t discontinuity_ns = kDiscontinuityNs,
                       int64_t default_step_ns = kDefaultStepNs);

  // 每次重建发布管线都必须调用:新管线的 base_time 又从 0 开始了。
  void Reset();

  // (源 DTS, 源 PTS) → 本管线时间轴上的 (DTS, PTS)。std::nullopt 表示该
  // 时间戳缺失(对应 Python 的 None)。首帧恒落在 0;输出 DTS 恒单调不减;
  // PTS 保留源侧的 B 帧重排偏移。
  std::pair<int64_t, int64_t> Map(std::optional<int64_t> src_dts,
                                   std::optional<int64_t> src_pts);

  int64_t discontinuities() const { return discontinuities_; }

 private:
  int64_t discontinuity_ns_;
  int64_t default_step_ns_;
  std::optional<int64_t> last_src_dts_;
  int64_t out_dts_ = 0;
  int64_t discontinuities_ = 0;
};

// es_sink 元素、诊断快照、拉流代数——由拉流侧(StreamSource)提供,发布器
// 不持有拉流管线的所有权,只通过这几个 provider 回调读取。
// EsSinkProvider 返回的元素**带一个引用**(调用方用完 gst_object_unref)——
// 拉流侧可能在别的线程重建管线,发布器阻塞在 try_pull_sample 期间不能让
// 这个元素被析构(Python 版局部变量天然持引用,C++ 必须显式)。
using EsSinkProvider = std::function<GstElement*()>;
using QueueDiagProvider = std::function<std::string()>;  // 诊断快照,格式化成字符串即可
using GenerationProvider = std::function<std::optional<int64_t>()>;

struct PublishStats {
  bool running = false;
  std::string rtmp_url;
  int64_t au_in = 0;
  int64_t au_pushed = 0;
  int64_t sei_injected = 0;
  BufferStats buffer;
  int64_t reconnect_count = 0;
  int64_t pub_queue_full_events = 0;
  std::optional<int64_t> pub_queue_level;
  int consecutive_failures = 0;
  bool reconnecting = false;
  std::optional<std::string> last_error;
  std::string codec = "h264";      // 当前发布管线按哪种编码建的
  std::string flv_format;          // H.265 时的输出写法(codec12/enhanced);H.264 为空
};

// 发布线程每一轮的走向(纯函数,便于单测)。needs_rebuild = 发布管线已请求重建;
// gap_seconds = 距上次有 AU 送进发布缓存的秒数(nullopt = 还没来过)。
// 上游源正在断线恢复时:没有 AU、空闲推流连接被流媒体服务踢掉,都是上游原因——
// 重建发布管线毫无作用,只会让流媒体服务反复换推流会话、下游录像/观看跟着重连
// (2026-10-09 相机停推后一天上百次)。此时等源恢复,恢复后只重建一次。
// 源正常却没有 AU(如编码环节卡住)仍走原有的看门狗重建路径。
enum class PublishStep { kRebuildNow, kWaitForSource, kFeeding, kCheckWatchdog };

enum class InitialBufferStep { kWait, kReady, kCapacityFault };
inline InitialBufferStep DecideInitialBuffer(const BufferStats& buffer, bool source_recovering) {
  if (source_recovering || buffer.level == 0) return InitialBufferStep::kWait;
  if (buffer.held_s >= buffer.controller.delay_s) return InitialBufferStep::kReady;
  if (buffer.byte_limit_events > 0 || buffer.frame_limit_events > 0)
    return InitialBufferStep::kCapacityFault;
  return InitialBufferStep::kWait;
}

inline PublishStep DecidePublishStep(bool needs_rebuild, std::optional<double> gap_seconds,
                                     double timeout_seconds, bool source_recovering) {
  if (needs_rebuild) return source_recovering ? PublishStep::kWaitForSource : PublishStep::kRebuildNow;
  if (gap_seconds.has_value() && *gap_seconds < timeout_seconds) return PublishStep::kFeeding;
  return source_recovering ? PublishStep::kWaitForSource : PublishStep::kCheckWatchdog;
}

// 上游源断线并恢复后,给下游一个新的发布会话边界(每次断线重建一次)。
// 断线期间不重建(见 DecidePublishStep);恢复后的新画面若接在旧会话里推出,下游读端
// 可能在会话中途解析错位且无从察觉(2026-10-09 录像读端零输出 26 分钟)。新会话让
// 下游按会话变化重新读取。断线期间已因错误重建过的(Reset)不再重复。
// 只在发布线程使用,不加锁。
class SourceRecoveryLatch {
 public:
  // recovering = 上游正在断线恢复;fresh_input = 新画面已送达发布缓存。
  // 返回 true = 应重建发布会话一次。
  bool Observe(bool recovering, bool fresh_input) {
    if (recovering) {
      interrupted_ = true;
      return false;
    }
    if (interrupted_ && fresh_input) {
      interrupted_ = false;
      return true;
    }
    return false;
  }
  void Reset() { interrupted_ = false; }

 private:
  bool interrupted_ = false;
};

// 单线程轮询:首个事件立即报告,随后最多每 30 秒汇总一次。
// 被限频的尾部事件即使不再增长,也会在下一次到期轮询时报告。
class PublishPressureReportGate {
 public:
  std::optional<std::pair<int64_t, int64_t>> Observe(int64_t events, int64_t units,
                                                   double now_mono) {
    if (events <= reported_events_) return std::nullopt;
    if (last_report_mono_ && now_mono - *last_report_mono_ < 30.0) return std::nullopt;
    auto delta = std::make_pair(events - reported_events_, units - reported_units_);
    reported_events_ = events;
    reported_units_ = units;
    last_report_mono_ = now_mono;
    return delta;
  }
 private:
  int64_t reported_events_ = 0;
  int64_t reported_units_ = 0;
  std::optional<double> last_report_mono_;
};

class StreamPublisher {
 public:
  struct Config {
    bool enabled = false;
    std::string rtmp_base = "rtmp://127.0.0.1:1935";
    double watchdog_timeout_seconds = 5.0;
    std::string srs_api_base = "http://127.0.0.1:1985";
    double reconnect_initial_delay = 1.0;
    double reconnect_max_delay = 10.0;
    double reconnect_backoff_factor = 2.0;
    // H.265 输出的 FLV 写法(设计 D3):codec12(默认)/ enhanced
    std::string flv_format = "codec12";
    // 长延迟通道先填充缓存，再连接推流端，避免空连接超时。
    bool wait_for_initial_buffer = false;
  };

  StreamPublisher(EsSinkProvider es_sink_provider, std::string channel_id, std::string rtmp_url,
                   std::shared_ptr<AuDelayBuffer> au_buffer, Config config,
                   QueueDiagProvider queue_diag_provider = nullptr,
                   GenerationProvider generation_provider = nullptr);
  ~StreamPublisher();

  StreamPublisher(const StreamPublisher&) = delete;
  StreamPublisher& operator=(const StreamPublisher&) = delete;

  void SetLicenseCheck(std::function<bool()> check) { license_check_ = std::move(check); }
  // 源编码(拉流侧当前管线的编码)。建/重建发布管线时按它选 264 或 265 分支;
  // 拉取 AU 时发现与已建管线不一致(相机换了编码)即触发重建(设计 §5.2 E2)。
  // 不设则恒为 H.264(行为不变)。须在 Start() 前设置。
  using CodecProvider = std::function<VideoCodec()>;
  void SetCodecProvider(CodecProvider p) { codec_provider_ = std::move(p); }
  // 上游源是否正在断线恢复(见 DecidePublishStep)。不设则视为恒正常(行为不变)。
  // 须在 Start() 前设置。
  using SourceRecoveringProvider = std::function<bool()>;
  void SetSourceRecoveringProvider(SourceRecoveringProvider p) { source_recovering_provider_ = std::move(p); }
  bool LicenseAllowed() const noexcept { try { return !license_check_ || license_check_(); } catch (...) { return false; } }
  void Start();
  void Stop();
  PublishStats GetStats() const;

 private:
  bool BuildPipeline();
  bool RebuildPipeline();
  void TeardownPipeline();
  std::optional<int64_t> ReadStreamGeneration() const;
  std::pair<std::optional<std::string>, std::optional<std::string>> ParseRtmpTarget() const;
  bool VerifySrsAcceptedStream();
  std::optional<int64_t> ReadPubQueueLevel() const;
  void OnPubQueueOverrun();
  void LogPushStall(double elapsed_ms);
  void LogBufferPressure();
  void LogQueueDiagOnWatchdog();
  bool Push(BufferedAu au);
  void PollBus();
  bool SourceRecovering() const;

  void PublishLoop();
  void PublishLoopIteration();
  void PullLoop();
  void PullLoopIteration();

  std::function<bool()> license_check_;
  EsSinkProvider es_sink_provider_;
  SourceRecoveringProvider source_recovering_provider_;
  SourceRecoveryLatch source_recovery_;  // 仅发布线程
  std::string channel_id_;
  std::string rtmp_url_;
  std::shared_ptr<AuDelayBuffer> buffer_;
  QueueDiagProvider queue_diag_provider_;
  GenerationProvider generation_provider_;
  Config cfg_;

  GstPipeline* pipeline_ = nullptr;
  GstElement* appsrc_ = nullptr;
  GstElement* sink_elem_ = nullptr;
  GstElement* pub_queue_ = nullptr;
  GstBus* bus_ = nullptr;

  std::thread pull_thread_;
  std::thread publish_thread_;
  std::atomic<bool> stop_event_{false};
  std::atomic<bool> initial_buffer_pending_{false};

  PtsRebaser pts_rebaser_;
  ReconnectStateMachine reconnect_;
  CodecProvider codec_provider_;
  VideoCodec CurrentSourceCodec() const;
  // 已建发布管线的编码(推流线程写、拉流/HTTP 线程读)
  std::atomic<int> pipeline_codec_{static_cast<int>(VideoCodec::kH264)};
  std::atomic<bool> codec_change_pending_{false};

  void SetLastError(std::string msg);
  std::optional<std::string> LastError() const;

  // 拉流线程/推流线程/GStreamer 流线程(overrun 信号)/HTTP 线程(GetStats)
  // 都会碰——一律原子或加锁,不能照抄 Python 版靠 GIL 的裸成员。
  std::atomic<int64_t> au_in_{0};
  std::atomic<int64_t> au_pushed_{0};
  std::atomic<int64_t> reconnect_count_{0};
  std::atomic<int64_t> pub_queue_full_events_{0};
  // 发布线程写、拉流诊断线程读,区分等待重建与 push 调用本身阻塞。
  std::atomic<double> last_push_started_mono_{0.0};
  std::atomic<double> last_push_success_mono_{0.0};
  std::atomic<double> last_push_elapsed_ms_{0.0};
  std::atomic<bool> push_in_progress_{false};
  PublishPressureReportGate buffer_report_gate_;  // 仅拉流线程
  PublishPressureReportGate push_report_gate_;    // 仅发布线程
  int64_t push_stall_events_ = 0;
  double push_stall_max_ms_ = 0.0;
  mutable std::mutex err_mutex_;
  std::optional<std::string> last_error_;
  // 保护 pub_queue_ 指针的读取与替换:GetStats(HTTP 线程)读水位时,推流
  // 线程可能正在 Teardown 把它释放。
  mutable std::mutex elem_mutex_;

  static constexpr double kPushStallWarnMs = 300.0;
};

}  // namespace ai_service::stream

#include "../utils/log.hpp"
#include "publisher.hpp"
#include "flv_hevc_elements.hpp"

#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

namespace ai_service::stream {

namespace {
constexpr const char* kByteStreamAuCaps = "video/x-h264, stream-format=byte-stream, alignment=au";
constexpr const char* kHevcByteStreamAuCaps = "video/x-h265, stream-format=byte-stream, alignment=au";

double NowMono() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
}  // namespace

// ========== PtsRebaser ==========

PtsRebaser::PtsRebaser(int64_t discontinuity_ns, int64_t default_step_ns)
    : discontinuity_ns_(discontinuity_ns), default_step_ns_(default_step_ns) {}

void PtsRebaser::Reset() {
  last_src_dts_.reset();
  out_dts_ = 0;
}

std::pair<int64_t, int64_t> PtsRebaser::Map(std::optional<int64_t> src_dts,
                                             std::optional<int64_t> src_pts) {
  std::optional<int64_t> dts = src_dts.has_value() ? src_dts : src_pts;

  int64_t reorder = 0;
  if (src_pts.has_value() && dts.has_value()) {
    reorder = *src_pts - *dts;
    if (reorder < 0) reorder = 0;
  }

  if (!dts.has_value()) {
    out_dts_ += default_step_ns_;
    return {out_dts_, out_dts_ + reorder};
  }

  if (!last_src_dts_.has_value()) {
    last_src_dts_ = dts;
    return {out_dts_, out_dts_ + reorder};
  }

  int64_t delta = *dts - *last_src_dts_;
  if (delta < 0 || delta > discontinuity_ns_) {
    discontinuities_++;
    delta = default_step_ns_;
  }
  last_src_dts_ = dts;
  out_dts_ += delta;
  return {out_dts_, out_dts_ + reorder};
}

// ========== StreamPublisher ==========

StreamPublisher::StreamPublisher(EsSinkProvider es_sink_provider, std::string channel_id,
                                  std::string rtmp_url, std::shared_ptr<AuDelayBuffer> au_buffer,
                                  Config config, QueueDiagProvider queue_diag_provider,
                                  GenerationProvider generation_provider)
    : es_sink_provider_(std::move(es_sink_provider)),
      channel_id_(std::move(channel_id)),
      rtmp_url_(std::move(rtmp_url)),
      buffer_(std::move(au_buffer)),
      queue_diag_provider_(std::move(queue_diag_provider)),
      generation_provider_(std::move(generation_provider)),
      cfg_(std::move(config)),
      reconnect_(channel_id_ + "/pub", cfg_.reconnect_initial_delay, cfg_.reconnect_max_delay,
                 cfg_.reconnect_backoff_factor, cfg_.watchdog_timeout_seconds,
                 [this]() { return RebuildPipeline(); }) {}

StreamPublisher::~StreamPublisher() { Stop(); }

void StreamPublisher::Start() {
  gst_init(nullptr, nullptr);
  initial_buffer_pending_.store(cfg_.wait_for_initial_buffer);
  if (!cfg_.wait_for_initial_buffer && !BuildPipeline()) {
    throw std::runtime_error("[" + channel_id_ + "] 发布管线构建失败");
  }
  stop_event_.store(false);
  pull_thread_ = std::thread([this] { PullLoop(); });
  publish_thread_ = std::thread([this] { PublishLoop(); });
  AI_LOG(kInfo, "ai-service.publisher", "[" << channel_id_ << "] 发布支路已启动 → " << rtmp_url_);
}

void StreamPublisher::Stop() {
  stop_event_.store(true);
  reconnect_.Stop();
  if (pull_thread_.joinable()) pull_thread_.join();
  if (publish_thread_.joinable()) publish_thread_.join();
  TeardownPipeline();
  AI_LOG(kInfo, "ai-service.publisher", "[" << channel_id_ << "] 发布支路已停止 (in=" << au_in_.load()
            << " pushed=" << au_pushed_.load() << " sei=" << buffer_->stats().stamped << ")");
}

PublishStats StreamPublisher::GetStats() const {
  PublishStats s;
  s.running = !stop_event_.load();
  s.rtmp_url = rtmp_url_;
  s.au_in = au_in_.load();
  s.au_pushed = au_pushed_.load();
  s.sei_injected = buffer_->stats().stamped;
  s.buffer = buffer_->stats();
  s.reconnect_count = reconnect_count_.load();
  s.pub_queue_full_events = pub_queue_full_events_.load();
  s.pub_queue_level = ReadPubQueueLevel();
  s.consecutive_failures = reconnect_.ConsecutiveFailures();
  s.reconnecting = reconnect_.NeedsReconnect();
  s.last_error = LastError();
  auto codec = static_cast<VideoCodec>(pipeline_codec_.load());
  s.codec = CodecName(codec);
  if (codec == VideoCodec::kH265) s.flv_format = cfg_.flv_format;
  return s;
}

VideoCodec StreamPublisher::CurrentSourceCodec() const {
  if (!codec_provider_) return VideoCodec::kH264;
  try {
    return codec_provider_();
  } catch (...) {
    return static_cast<VideoCodec>(pipeline_codec_.load());
  }
}

void StreamPublisher::SetLastError(std::string msg) {
  std::lock_guard<std::mutex> lock(err_mutex_);
  last_error_ = std::move(msg);
}

std::optional<std::string> StreamPublisher::LastError() const {
  std::lock_guard<std::mutex> lock(err_mutex_);
  return last_error_;
}

// ---- 主循环(推流线程) ----

void StreamPublisher::PublishLoop() {
  while (!stop_event_.load() && LicenseAllowed()) {
    PublishLoopIteration();
  }
}

bool StreamPublisher::SourceRecovering() const {
  if (!source_recovering_provider_) return false;
  try {
    return source_recovering_provider_();
  } catch (...) {
    return false;  // 查询失败按"源正常"处理,保持原有行为
  }
}

void StreamPublisher::PublishLoopIteration() {
  if (initial_buffer_pending_.load()) {
    const auto buffered = buffer_->stats();
    const auto step = DecideInitialBuffer(buffered, SourceRecovering());
    if (step == InitialBufferStep::kCapacityFault) {
      const std::string message = "输出缓存容量不足以等待识别结果，请降低源码率或更换模型后重启通道";
      SetLastError(message);
      AI_LOG(kError, "ai-service.publisher", "[" << channel_id_ << "] " << message);
      stop_event_.store(true);  // 明确停止输出，不能无限等一个永远攒不满的窗口。
      return;
    }
    if (step == InitialBufferStep::kWait) {
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
      return;
    }
    if (!BuildPipeline()) reconnect_.TriggerReconnect("发布管线构建失败");
    initial_buffer_pending_.store(false);
    return;
  }
  if (reconnect_.NeedsReconnect()) {
    if (DecidePublishStep(true, std::nullopt, cfg_.watchdog_timeout_seconds, SourceRecovering()) ==
        PublishStep::kWaitForSource) {
      // 上游断线中:先不重建(重建出来也是一条会被踢掉的空连接),源恢复后再建一次
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      return;
    }
    // 本次重建已给下游新的会话边界,源恢复后不必再重建
    source_recovery_.Reset();
    reconnect_.DoReconnect();
    return;
  }

  PollBus();

  // 2026-09-09 生产事故修复:_poll_bus() 刚检测到总线 ERROR 会把
  // needs_reconnect 置位;必须立刻 return,不能让本轮循环继续往下走到
  // on_frame_received()——那会在下一轮顶部的 needs_reconnect 检查生效
  // 之前,把刚设置的重连请求自己抹掉(RTMP-only 断流、ES 侧仍在正常出
  // 数据时这条竞态在生产环境不是小概率事件)。
  if (reconnect_.NeedsReconnect()) {
    return;
  }

  double now = NowMono();
  auto gap = buffer_->seconds_since_last_put(now);
  const bool recovering = SourceRecovering();
  const auto step = DecidePublishStep(false, gap, cfg_.watchdog_timeout_seconds, recovering);
  if (source_recovery_.Observe(recovering, step == PublishStep::kFeeding)) {
    AI_LOG(kInfo, "ai-service.publisher",
           "[" << channel_id_ << "] 输入源断线后已恢复,重建发布会话(下游按新会话重新读取)");
    reconnect_.TriggerReconnect("输入源断线后已恢复,重建发布会话");
    return;
  }
  switch (step) {
    case PublishStep::kFeeding:
    case PublishStep::kWaitForSource:
      // 源断线恢复期间不让看门狗触发重建;源恢复出帧后直接接着推
      reconnect_.OnFrameReceived();
      break;
    case PublishStep::kCheckWatchdog:
      if (reconnect_.CheckWatchdog()) {
        LogQueueDiagOnWatchdog();
        return;
      }
      break;
    case PublishStep::kRebuildNow:
      break;  // needs_rebuild=false 时不会出现
  }

  auto au = buffer_->pop_ready(now);
  if (!au.has_value()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    return;
  }

  if (Push(std::move(*au))) {
    au_pushed_++;
  }
}

// ---- 拉流线程 ----

void StreamPublisher::PullLoop() {
  while (!stop_event_.load() && LicenseAllowed()) {
    try {
      PullLoopIteration();
    } catch (const std::exception& e) {
      AI_LOG(kError, "ai-service.publisher", "[" << channel_id_ << "] 拉流线程异常: " << e.what());
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
  }
}

void StreamPublisher::PullLoopIteration() {
  auto generation = ReadStreamGeneration();
  GstElement* es_sink = es_sink_provider_ ? es_sink_provider_() : nullptr;
  if (!es_sink) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    return;
  }
  GstSample* sample =
      gst_app_sink_try_pull_sample(GST_APP_SINK(es_sink), 100 * GST_MSECOND);
  gst_object_unref(es_sink);  // provider 给的引用;sample 自带对 buffer 的引用
  if (!sample) return;

  GstBuffer* buf = gst_sample_get_buffer(sample);
  if (!buf) {
    gst_sample_unref(sample);
    return;
  }
  GstMapInfo map_info;
  if (!gst_buffer_map(buf, &map_info, GST_MAP_READ)) {
    gst_sample_unref(sample);
    return;
  }
  std::vector<uint8_t> data(map_info.data, map_info.data + map_info.size);
  gst_buffer_unmap(buf, &map_info);

  if (generation != ReadStreamGeneration()) {
    gst_sample_unref(sample);
    return;
  }

  au_in_++;
  // 相机换了编码:拉流侧已按新编码重建,旧发布管线的 caps/封装都不对了——
  // 触发发布管线重建(只触发一次,重建时按新编码)。本 AU 属于新编码,丢掉。
  const VideoCodec src_codec = CurrentSourceCodec();
  if (!initial_buffer_pending_.load() && src_codec != static_cast<VideoCodec>(pipeline_codec_.load())) {
    if (!codec_change_pending_.exchange(true)) {
      std::string msg = std::string("源编码变化(") + CodecName(static_cast<VideoCodec>(pipeline_codec_.load())) +
                        " → " + CodecName(src_codec) + "),重建发布管线";
      AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] " << msg);
      reconnect_.TriggerReconnect(msg);
    }
    gst_sample_unref(sample);
    return;
  }
  BufferedAu au;
  au.pts_ns =
      (GST_BUFFER_PTS(buf) != GST_CLOCK_TIME_NONE) ? static_cast<int64_t>(GST_BUFFER_PTS(buf)) : -1;
  au.dts_ns =
      (GST_BUFFER_DTS(buf) != GST_CLOCK_TIME_NONE) ? static_cast<int64_t>(GST_BUFFER_DTS(buf)) : -1;
  au.duration_ns = (GST_BUFFER_DURATION(buf) != GST_CLOCK_TIME_NONE)
                       ? static_cast<int64_t>(GST_BUFFER_DURATION(buf))
                       : 0;
  // 缓存的"丢帧后重新对齐"只能在安全恢复点切:265 只认 IDR(设计 §6.4)
  au.is_keyframe = IsShedResumePoint(src_codec, GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT),
                                     data.data(), data.size());
  au.data = std::move(data);
  au.arrived_mono = NowMono();
  au.generation = generation;

  buffer_->put(std::move(au));
  gst_sample_unref(sample);
  // 缓存锁已经释放;日志写入不能发生在拉流/推理/发布共享锁内。
  LogBufferPressure();
}

void StreamPublisher::LogQueueDiagOnWatchdog() {
  if (!queue_diag_provider_) return;
  try {
    std::string diag = queue_diag_provider_();
    AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] watchdog 触发时 q_pub 状态: " << diag);
  } catch (...) {
    // 诊断本身失败不能影响重连主流程,静默跳过。
  }
}

bool StreamPublisher::Push(BufferedAu au) {
  if (!LicenseAllowed()) return false;
  if (!appsrc_ || stop_event_.load()) return false;
  if (au.generation != ReadStreamGeneration()) return false;

  // GstBuffer 持有数据的一份独立堆分配副本,生命周期绑定 GDestroyNotify——
  // au.data 是从 AuDelayBuffer 里取出来的局部拷贝,函数返回后就没了,不能
  // 指望它比 GstBuffer 活得久。
  auto* owned = new std::vector<uint8_t>(std::move(au.data));
  GstBuffer* out = gst_buffer_new_wrapped_full(
      GST_MEMORY_FLAG_READONLY, owned->data(), owned->size(), 0, owned->size(), owned,
      [](gpointer data) { delete static_cast<std::vector<uint8_t>*>(data); });

  auto [out_dts, out_pts] = pts_rebaser_.Map(au.dts_ns >= 0 ? std::optional<int64_t>(au.dts_ns)
                                                             : std::nullopt,
                                              au.pts_ns >= 0 ? std::optional<int64_t>(au.pts_ns)
                                                             : std::nullopt);
  GST_BUFFER_PTS(out) = static_cast<GstClockTime>(out_pts);
  GST_BUFFER_DTS(out) = static_cast<GstClockTime>(out_dts);
  GST_BUFFER_DURATION(out) = static_cast<GstClockTime>(au.duration_ns);

  double t0 = NowMono();
  last_push_started_mono_.store(t0);
  push_in_progress_.store(true);
  GstFlowReturn flow = gst_app_src_push_buffer(GST_APP_SRC(appsrc_), out);
  push_in_progress_.store(false);
  double elapsed_ms = (NowMono() - t0) * 1000.0;
  last_push_elapsed_ms_.store(elapsed_ms);
  if (elapsed_ms > kPushStallWarnMs) {
    LogPushStall(elapsed_ms);
  }
  if (flow != GST_FLOW_OK) {
    std::string msg = "push-buffer: " + std::to_string(static_cast<int>(flow));
    SetLastError(msg);
    reconnect_.TriggerReconnect(msg);
    return false;
  }
  last_push_success_mono_.store(NowMono());
  return true;
}

std::optional<int64_t> StreamPublisher::ReadPubQueueLevel() const {
  GstElement* q = nullptr;
  {
    std::lock_guard<std::mutex> lock(elem_mutex_);
    if (!pub_queue_) return std::nullopt;
    q = GST_ELEMENT(gst_object_ref(pub_queue_));
  }
  guint level = 0;
  g_object_get(q, "current-level-buffers", &level, nullptr);
  gst_object_unref(q);
  return static_cast<int64_t>(level);
}

void StreamPublisher::OnPubQueueOverrun() {
  int64_t n = ++pub_queue_full_events_;
  if (n <= 3) {
    AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] 发布队列满载(反压阻塞,累计 "
              << n << ";恒速稳态下属正常,后续不再逐次记录,见 stats)");
  }
}

void StreamPublisher::LogPushStall(double elapsed_ms) {
  ++push_stall_events_;
  push_stall_max_ms_ = std::max(push_stall_max_ms_, elapsed_ms);
  if (!push_report_gate_.Observe(push_stall_events_, 0, NowMono())) return;
  AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] publish_push_stall"
         << " elapsed_ms=" << elapsed_ms << " max_ms=" << push_stall_max_ms_
         << " events_total=" << push_stall_events_);
}

void StreamPublisher::LogBufferPressure() {
  const auto s = buffer_->stats();
  const double now = NowMono();
  const auto report = buffer_report_gate_.Observe(s.drop_events, s.dropped, now);
  if (!report || !s.last_eviction) return;
  const auto& e = *s.last_eviction;
  const double last_success = last_push_success_mono_.load();
  const bool push_active = push_in_progress_.load();
  const auto level = ReadPubQueueLevel();
  AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] publish_buffer_eviction"
         << " events_delta=" << report->first << " dropped_delta=" << report->second
         << " events_total=" << s.drop_events << " dropped_total=" << s.dropped
         << " reason_mask=" << e.reasons << " age_events=" << s.age_limit_events
         << " byte_events=" << s.byte_limit_events << " frame_events=" << s.frame_limit_events
         << " oldest_age_s=" << e.oldest_age_s << " hold_limit_s=" << e.hold_limit_s
         << " bytes_before=" << e.bytes_before << " frames_before=" << e.frames_before
         << " removed_last=" << e.removed << " keyframe_resume=" << e.resumed_at_keyframe
         << " generation=" << e.generation.value_or(-1)
         << " event_ago_s=" << now - e.at_mono
         << " source_recovering=" << SourceRecovering()
         << " reconnecting=" << reconnect_.NeedsReconnect()
         << " reconnect_count=" << reconnect_count_.load()
         << " push_active=" << push_active
         << " push_wait_ms=" << (push_active ? (now - last_push_started_mono_.load()) * 1000.0 : 0.0)
         << " push_elapsed_ms=" << last_push_elapsed_ms_.load()
         << " push_age_s=" << (last_success > 0.0 ? now - last_success : -1.0)
         << " pub_queue_level=" << level.value_or(-1)
         << " queue_full_events=" << pub_queue_full_events_.load());
}

// ---- 发布管线 ----

bool StreamPublisher::BuildPipeline() {
  // ⚠️ 必须先重基时间轴再建管线:新管线的 base_time 从 0 开始,而源 PTS
  // 可能已经涨到几千秒。漏掉这一步 = 重建出来的管线一个媒体字节都发不
  // 出去、30s 后必报 Connection error,且再也不会自愈。
  pts_rebaser_.Reset();
  // 按源的当前编码建:H.264 与改造前完全一致;H.265 用 h265parse 转 hvc1 后交给
  // ainvrflvmux(GStreamer 1.20 的 flvmux 不认 HEVC),输出写法按 cfg_.flv_format
  const VideoCodec codec = CurrentSourceCodec();
  const bool hevc = codec == VideoCodec::kH265;
  if (hevc && !RegisterTecheFlvElements()) {
    AI_LOG(kError, "ai-service.publisher", "[" << channel_id_ << "] ainvrflvmux 注册失败");
    return false;
  }

  GstPipeline* p = GST_PIPELINE(gst_pipeline_new(("pub-" + channel_id_).c_str()));

  GstElement* appsrc = gst_element_factory_make("appsrc", "es_src");
  g_object_set(appsrc, "is-live", TRUE, "format", GST_FORMAT_TIME, nullptr);
  GstCaps* caps = gst_caps_from_string(hevc ? kHevcByteStreamAuCaps : kByteStreamAuCaps);
  g_object_set(appsrc, "caps", caps, nullptr);
  gst_caps_unref(caps);

  GstElement* q = gst_element_factory_make("queue", "q");
  // 直播透传防延迟累积:上限只留吸收合并写突发的余量(5 帧),leaky 保持
  // none(满了阻塞走反压,绝不在这里丢帧)——真正的丢帧点在上游
  // es_sink(drop=true)+ q_pub 的 GOP-aware 探针,只在关键帧边界丢。这个
  // 队列若丢帧会落在 GOP 中间,长时间花屏。
  g_object_set(q, "max-size-buffers", 5, "max-size-bytes", 0, "max-size-time",
               static_cast<guint64>(0), "leaky", 0, nullptr);
  g_signal_connect(q, "overrun", G_CALLBACK(+[](GstElement*, gpointer user_data) {
                      static_cast<StreamPublisher*>(user_data)->OnPubQueueOverrun();
                    }),
                   this);

  GstElement* parse = gst_element_factory_make(hevc ? "h265parse" : "h264parse", "parse");
  GstElement* hvc1 = nullptr;
  GstElement* mux = nullptr;
  if (hevc) {
    hvc1 = gst_element_factory_make("capsfilter", "hvc1");
    GstCaps* hc = gst_caps_from_string("video/x-h265, stream-format=hvc1, alignment=au");
    g_object_set(hvc1, "caps", hc, nullptr);
    gst_caps_unref(hc);
    mux = gst_element_factory_make("ainvrflvmux", "mux");
    g_object_set(mux, "format", cfg_.flv_format.c_str(), nullptr);
  } else {
    mux = gst_element_factory_make("flvmux", "mux");
    g_object_set(mux, "streamable", TRUE, nullptr);
  }
  GstElement* sink = gst_element_factory_make("rtmp2sink", "out");
  g_object_set(sink, "location", rtmp_url_.c_str(), nullptr);
  // 发送端绝不能 sync=true:sync 是给播放端按 PTS 节奏渲染用的,推流端
  // 应该来多少发多少,否则时钟偏差会让延迟越积越多。async=false 避免
  // 直播场景不存在的 preroll 阶段无谓等待。
  g_object_set(sink, "sync", FALSE, "async", FALSE, nullptr);

  gst_bin_add_many(GST_BIN(p), appsrc, q, parse, mux, sink, nullptr);
  bool linked = gst_element_link(appsrc, q) && gst_element_link(q, parse) && gst_element_link(mux, sink);
  if (hevc) {
    gst_bin_add(GST_BIN(p), hvc1);
    linked = linked && gst_element_link(parse, hvc1) && gst_element_link(hvc1, mux);
  } else {
    linked = linked && gst_element_link(parse, mux);
  }
  if (!linked) {
    AI_LOG(kError, "ai-service.publisher", "[" << channel_id_ << "] 发布管线链接失败");
    gst_object_unref(GST_OBJECT(p));
    return false;
  }

  pipeline_ = p;
  appsrc_ = appsrc;
  sink_elem_ = sink;
  pipeline_codec_.store(static_cast<int>(codec));
  codec_change_pending_.store(false);
  if (hevc) {
    AI_LOG(kInfo, "ai-service.publisher",
           "[" << channel_id_ << "] H.265 发布管线(ainvrflvmux format=" << cfg_.flv_format << ")");
  }
  {
    std::lock_guard<std::mutex> lock(elem_mutex_);
    pub_queue_ = q;
  }
  bus_ = gst_pipeline_get_bus(p);
  gst_element_set_state(GST_ELEMENT(p), GST_STATE_PLAYING);
  return true;
}

bool StreamPublisher::RebuildPipeline() {
  int64_t n_rebuild = ++reconnect_count_;
  TeardownPipeline();
  if (!BuildPipeline()) return false;
  AI_LOG(kInfo, "ai-service.publisher", "[" << channel_id_ << "] 发布管线已重建 (第 " << n_rebuild << " 次)");

  // TOCTOU 收口起点:先记下拉流代数,再取 es_sink、做全部校验。
  auto gen_before = ReadStreamGeneration();
  GstElement* es_sink = es_sink_provider_ ? es_sink_provider_() : nullptr;
  if (es_sink) gst_object_unref(es_sink);  // 这里只确认拉流侧已就绪,不使用元素本身
  if (!es_sink) {
    // 拉流侧尚未就绪。不能声称"成功"(那会让 ReconnectStateMachine 清零
    // consecutive_failures、复位退避起点),而 appsrc 此刻没有任何上游
    // 数据通路,SRS 会看到"连上但无数据"的流——按失败处理交给指数退避,
    // 拉流侧就绪后下一轮重试自然收敛。
    return false;
  }

  double deadline = NowMono() + buffer_->controller()->max_delay_s() + 2.0;
  bool es_resumed = false;
  while (NowMono() < deadline && !stop_event_.load()) {
    if (gen_before != ReadStreamGeneration()) return false;
    auto au = buffer_->pop_ready(NowMono());
    if (au.has_value() && Push(std::move(*au))) {
      au_pushed_++;
      es_resumed = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  if (!es_resumed) return false;

  if (!VerifySrsAcceptedStream()) return false;

  // 等待缓存数据和核实 SRS 期间源可能再次重建;整次验证必须属于同一代。
  auto gen_after = ReadStreamGeneration();
  if (gen_before.has_value() && gen_after != gen_before) {
    AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] 重连校验期间拉流管线代数变化,本次校验作废,按失败退避重试");
    return false;
  }

  return true;
}

std::optional<int64_t> StreamPublisher::ReadStreamGeneration() const {
  if (!generation_provider_) return std::nullopt;
  try {
    return generation_provider_();
  } catch (...) {
    return std::nullopt;
  }
}

std::pair<std::optional<std::string>, std::optional<std::string>>
StreamPublisher::ParseRtmpTarget() const {
  // rtmp://host:port/app/stream[?...] —— 只取 path 的前两段。
  auto scheme_pos = rtmp_url_.find("://");
  if (scheme_pos == std::string::npos) return {std::nullopt, std::nullopt};
  auto path_start = rtmp_url_.find('/', scheme_pos + 3);
  if (path_start == std::string::npos) return {std::nullopt, std::nullopt};
  std::string path = rtmp_url_.substr(path_start + 1);
  auto q_pos = path.find('?');
  if (q_pos != std::string::npos) path = path.substr(0, q_pos);

  std::vector<std::string> parts;
  size_t start = 0;
  while (start < path.size()) {
    auto slash = path.find('/', start);
    std::string part = (slash == std::string::npos) ? path.substr(start) : path.substr(start, slash - start);
    if (!part.empty()) parts.push_back(part);
    if (slash == std::string::npos) break;
    start = slash + 1;
  }
  if (parts.size() >= 2) return {parts[0], parts[1]};
  return {std::nullopt, std::nullopt};
}

bool StreamPublisher::VerifySrsAcceptedStream() {
  if (cfg_.srs_api_base.empty()) return true;
  auto [app, stream_name] = ParseRtmpTarget();
  if (!app.has_value() || !stream_name.has_value()) return true;

  double deadline = NowMono() + 2.0;
  bool api_reachable = false;
  while (NowMono() < deadline && !stop_event_.load()) {
    // 本方法运行在唯一推流线程,验证期间仍需供给编码帧。
    for (int i = 0; i < 32; ++i) {
      auto au = buffer_->pop_ready(NowMono());
      if (!au.has_value()) break;
      if (!Push(std::move(*au))) return false;
      au_pushed_++;
    }

    try {
      httplib::Client cli(cfg_.srs_api_base);
      cli.set_connection_timeout(1, 0);
      cli.set_read_timeout(1, 0);
      auto res = cli.Get("/api/v1/streams/");
      if (res && res->status == 200) {
        api_reachable = true;
        auto j = nlohmann::json::parse(res->body, nullptr, false);
        if (!j.is_discarded() && j.contains("streams")) {
          for (auto& s : j["streams"]) {
            if (s.value("app", "") == *app && s.value("name", "") == *stream_name) {
              return true;
            }
          }
        }
      }
    } catch (...) {
      // 网络/解析异常都当作本轮探测失败,继续轮询直到 deadline。
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
  }

  if (!api_reachable) {
    AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] 无法访问 SRS API(" << cfg_.srs_api_base
              << ")核实推流状态,退回信任本地 ES 判定");
    return true;
  }
  AI_LOG(kWarning, "ai-service.publisher", "[" << channel_id_ << "] SRS 未在窗口内注册到流 " << *app << "/" << *stream_name
            << ",判定本次重连失败");
  return false;
}

void StreamPublisher::TeardownPipeline() {
  GstPipeline* p = pipeline_;
  pipeline_ = nullptr;
  appsrc_ = nullptr;
  sink_elem_ = nullptr;
  {
    std::lock_guard<std::mutex> lock(elem_mutex_);
    pub_queue_ = nullptr;
  }
  // gst_pipeline_get_bus() 给的是新引用:只置空会每次重建漏一个总线(含一对唤醒句柄)
  if (bus_) gst_object_unref(bus_);
  bus_ = nullptr;
  if (p) {
    // 与 Python 版的已知差异:v1 把 set_state(NULL) 丢给有超时上限的守护
    // 线程异步执行;这里同步执行。代价是 NULL 化卡住时(rtmp2sink 自身超时)
    // 调用线程会等;好处是 Stop() 返回时旧管线已经彻底停下——通道重启
    // (ChannelManager 先 Stop 旧 Worker 再建新 Worker)时不会出现 v1 那种
    // "旧管线还在收尾、和新管线抢同一个推流目标"的竞态。appsrc 是
    // block=false,push_buffer 不会阻塞到让 join 挂死。
    gst_element_set_state(GST_ELEMENT(p), GST_STATE_NULL);
    gst_object_unref(GST_OBJECT(p));
  }
}

void StreamPublisher::PollBus() {
  if (!bus_) return;
  while (true) {
    GstMessage* msg = gst_bus_pop(bus_);
    if (!msg) return;
    if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
      GError* err = nullptr;
      gchar* debug = nullptr;
      gst_message_parse_error(msg, &err, &debug);
      std::string emsg = err ? err->message : "unknown";
      SetLastError(emsg);
      reconnect_.TriggerReconnect("发布管线错误: " + emsg);
      AI_LOG(kError, "ai-service.publisher", "[" << channel_id_ << "] 发布管线错误: " << emsg);
      if (err) g_error_free(err);
      if (debug) g_free(debug);
      gst_message_unref(msg);
      return;
    }
    if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_EOS) {
      SetLastError("发布管线 EOS(对端提前关闭连接)");
      reconnect_.TriggerReconnect("发布管线 EOS");
      gst_message_unref(msg);
      return;
    }
    gst_message_unref(msg);
  }
}

}  // namespace ai_service::stream

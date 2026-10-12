#include "flv_hevc_elements.hpp"

#include <gst/gst.h>

#include <algorithm>
#include <mutex>
#include <string>
#include <vector>

#include "flv_hevc.hpp"

namespace ai_service::stream {

namespace {

using flv::HevcFlvFormat;
using flv::VideoPacket;

constexpr int kMaxConsecutiveBadFrames = 50;
constexpr int64_t kMaxResyncBytes = 1 << 20;   // 一次重同步跳过超过 1 MiB → 输入已不可用
constexpr int64_t kDiscontBackMs = 1000;       // 时间戳回退超过 1s
constexpr int64_t kDiscontJumpMs = 10000;      // 或前跳超过 10s → DISCONT
constexpr int64_t kMaxIdrWaitMs = 10000;       // 等 IDR 超过 10s(按 DTS)→ 明确报错

GstBuffer* NewBuffer(const std::vector<uint8_t>& v) { return gst_buffer_new_memdup(v.data(), v.size()); }

// ============================================================================
// ainvrflvdemux
// ============================================================================

struct TecheFlvDemux {
  GstElement parent;
  GstPad* sinkpad;
  GstPad* srcpad;
  flv::TagReader* reader;
  std::vector<uint8_t>* hvcc;  // 当前序列头(空 = 尚未收到)
  int length_size;
  int consecutive_bad;
  guint64 dropped_frames;
  bool warned_bframes;
  bool pending_discont;
  // 参考链断了(开流、丢损坏帧、tag 重同步):后续 P 帧缺参考,丢到下一个 IDR 为止
  bool await_idr;
  int64_t await_since_dts_ms;  // -1 = 还没见到等待期间的帧
  int64_t seen_resyncs;
  int64_t last_dts_ms;
  HevcFlvFormat format;
  bool format_known;
};

struct TecheFlvDemuxClass {
  GstElementClass parent_class;
};

enum { PROP_DEMUX_0, PROP_DROPPED_FRAMES, PROP_RESYNCS, PROP_DEMUX_FORMAT, PROP_BFRAMES };

GType ainvr_flv_demux_get_type();
G_DEFINE_TYPE(TecheFlvDemux, ainvr_flv_demux, GST_TYPE_ELEMENT)

GstStaticPadTemplate demux_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-flv"));
GstStaticPadTemplate demux_src_tmpl = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-h265, stream-format=(string)hvc1, alignment=(string)au"));

void DemuxResetState(TecheFlvDemux* self) {
  self->reader->Reset();
  self->consecutive_bad = 0;
  self->pending_discont = true;
  self->await_idr = true;
  self->await_since_dts_ms = -1;
  self->seen_resyncs = self->reader->resyncs();
  self->last_dts_ms = -1;
}

void DemuxAwaitIdr(TecheFlvDemux* self) {
  if (!self->await_idr) {
    self->await_idr = true;
    self->await_since_dts_ms = -1;
  }
}

GstFlowReturn DemuxBadFrame(TecheFlvDemux* self, const std::string& why) {
  self->dropped_frames++;
  DemuxAwaitIdr(self);
  if (++self->consecutive_bad >= kMaxConsecutiveBadFrames) {
    GST_ELEMENT_ERROR(self, STREAM, DECODE, ("连续 %d 个 H.265 帧损坏,输入不可用", kMaxConsecutiveBadFrames),
                      ("%s", why.c_str()));
    return GST_FLOW_ERROR;
  }
  return GST_FLOW_OK;
}

bool DemuxSetCaps(TecheFlvDemux* self) {
  gchar* sid = gst_pad_create_stream_id(self->srcpad, GST_ELEMENT(self), nullptr);
  gst_pad_push_event(self->srcpad, gst_event_new_stream_start(sid));
  g_free(sid);
  GstBuffer* cd = NewBuffer(*self->hvcc);
  GstCaps* caps = gst_caps_new_simple("video/x-h265", "stream-format", G_TYPE_STRING, "hvc1", "alignment",
                                      G_TYPE_STRING, "au", "codec_data", GST_TYPE_BUFFER, cd, nullptr);
  gst_buffer_unref(cd);
  bool ok = gst_pad_push_event(self->srcpad, gst_event_new_caps(caps));
  gst_caps_unref(caps);
  GstSegment seg;
  gst_segment_init(&seg, GST_FORMAT_TIME);
  gst_pad_push_event(self->srcpad, gst_event_new_segment(&seg));
  return ok;
}

GstFlowReturn DemuxHandleVideo(TecheFlvDemux* self, const flv::Tag& tag) {
  VideoPacket p;
  std::string err;
  switch (flv::ParseHevcVideoTag(tag.body.data(), tag.body.size(), &p, &err)) {
    case flv::ParseResult::kNotHevc:
      GST_ELEMENT_ERROR(self, STREAM, WRONG_TYPE, ("不支持的 FLV 视频封装:%s", err.c_str()), (nullptr));
      return GST_FLOW_ERROR;
    case flv::ParseResult::kUnsupported:
      return GST_FLOW_OK;
    case flv::ParseResult::kMalformed:
      return DemuxBadFrame(self, err);
    case flv::ParseResult::kOk:
      break;
  }
  self->format = p.format;
  self->format_known = true;

  if (p.kind == VideoPacket::Kind::kEndOfSequence) return GST_FLOW_OK;
  if (p.kind == VideoPacket::Kind::kSequenceHeader) {
    flv::HvccInfo info;
    if (!flv::ParseHvcc(p.data.data(), p.data.size(), &info, &err)) {
      GST_ELEMENT_ERROR(self, STREAM, FORMAT, ("H.265 序列头无效:%s", err.c_str()), (nullptr));
      return GST_FLOW_ERROR;
    }
    p.data = std::move(info.normalized);
    if (self->hvcc->empty()) {
      *self->hvcc = p.data;
      self->length_size = info.length_size;
      if (!DemuxSetCaps(self)) return GST_FLOW_NOT_NEGOTIATED;
      return GST_FLOW_OK;
    }
    if (*self->hvcc == p.data) return GST_FLOW_OK;  // 重复的相同序列头
    // Repeated SRT headers may change only container hints (average frame
    // rate, spatial segmentation, etc.). Reconnect only for decoder changes;
    // retaining the original caps also avoids disturbing in-flight frames.
    flv::HvccInfo previous;
    if (flv::ParseHvcc(self->hvcc->data(), self->hvcc->size(), &previous, &err) &&
        previous.length_size == info.length_size && previous.vps == info.vps &&
        previous.sps == info.sps && previous.pps == info.pps) {
      return GST_FLOW_OK;
    }
    GST_ELEMENT_ERROR(self, STREAM, FORMAT, ("源参数变化(H.265 序列头内容改变),需要重建管线"), (nullptr));
    return GST_FLOW_ERROR;
  }

  // 帧
  if (self->hvcc->empty()) {  // 还没有序列头:无法解码,丢弃
    self->dropped_frames++;
    return GST_FLOW_OK;
  }
  if (!flv::LengthPrefixedValid(p.data.data(), p.data.size(), self->length_size)) {
    return DemuxBadFrame(self, "NAL 长度越界");
  }
  self->consecutive_bad = 0;
  const int64_t dts_ms = tag.timestamp_ms;
  const bool idr = flv::LengthPrefixedIsIdr(p.data.data(), p.data.size(), self->length_size);
  if (self->await_idr) {
    if (!idr) {
      self->dropped_frames++;
      if (self->await_since_dts_ms < 0) self->await_since_dts_ms = dts_ms;
      if (dts_ms - self->await_since_dts_ms > kMaxIdrWaitMs) {
        GST_ELEMENT_ERROR(self, STREAM, DECODE,
                          ("H.265 源超过 %d 秒没有 IDR 关键帧,无法恢复解码(相机可能是开放 GOP/只有 CRA,"
                           "请改为闭合 GOP 并缩短关键帧间隔)",
                           static_cast<int>(kMaxIdrWaitMs / 1000)),
                          (nullptr));
        return GST_FLOW_ERROR;
      }
      return GST_FLOW_OK;
    }
    self->await_idr = false;
    self->await_since_dts_ms = -1;
    self->pending_discont = true;  // 恢复点:告诉下游这里断过
  }
  if (p.cts_ms != 0 && !self->warned_bframes) {
    self->warned_bframes = true;
    GST_ELEMENT_WARNING(self, STREAM, FORMAT, ("源含 B 帧(CTS≠0),WebRTC 播放可能异常,建议相机关闭 B 帧"),
                        (nullptr));
  }
  GstBuffer* buf = NewBuffer(p.data);
  if (self->pending_discont ||
      (self->last_dts_ms >= 0 && (dts_ms < self->last_dts_ms - kDiscontBackMs ||
                                  dts_ms > self->last_dts_ms + kDiscontJumpMs))) {
    GST_BUFFER_FLAG_SET(buf, GST_BUFFER_FLAG_DISCONT);
    self->pending_discont = false;
  }
  self->last_dts_ms = dts_ms;
  const int64_t pts_ms = std::max<int64_t>(0, dts_ms + p.cts_ms);
  GST_BUFFER_DTS(buf) = static_cast<GstClockTime>(dts_ms) * GST_MSECOND;
  GST_BUFFER_PTS(buf) = static_cast<GstClockTime>(pts_ms) * GST_MSECOND;
  if (!idr) GST_BUFFER_FLAG_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT);
  return gst_pad_push(self->srcpad, buf);
}

GstFlowReturn DemuxChain(GstPad*, GstObject* parent, GstBuffer* buffer) {
  auto* self = reinterpret_cast<TecheFlvDemux*>(parent);
  GstMapInfo m;
  if (gst_buffer_map(buffer, &m, GST_MAP_READ)) {
    self->reader->Push(m.data, m.size);
    gst_buffer_unmap(buffer, &m);
  }
  gst_buffer_unref(buffer);
  while (auto tag = self->reader->Next()) {
    if (self->reader->resyncs() != self->seen_resyncs) {  // 跳过的字节里可能有整帧
      self->seen_resyncs = self->reader->resyncs();
      DemuxAwaitIdr(self);
    }
    if (tag->type != flv::kTagVideo) continue;  // 音频、脚本 tag 不需要
    GstFlowReturn r = DemuxHandleVideo(self, *tag);
    if (r != GST_FLOW_OK) return r;
  }
  if (self->reader->episode_skipped() > kMaxResyncBytes) {
    GST_ELEMENT_ERROR(self, STREAM, DEMUX, ("FLV 输入持续损坏(重同步已跳过超过 1 MiB)"), (nullptr));
    return GST_FLOW_ERROR;
  }
  return GST_FLOW_OK;
}

gboolean DemuxSinkEvent(GstPad* pad, GstObject* parent, GstEvent* event) {
  auto* self = reinterpret_cast<TecheFlvDemux*>(parent);
  switch (GST_EVENT_TYPE(event)) {
    case GST_EVENT_CAPS:
    case GST_EVENT_SEGMENT:
    case GST_EVENT_STREAM_START:
      // 上游是字节流:这些由本元件在拿到序列头后自己产生
      gst_event_unref(event);
      return TRUE;
    case GST_EVENT_FLUSH_STOP:
      DemuxResetState(self);
      return gst_pad_event_default(pad, parent, event);
    default:
      return gst_pad_event_default(pad, parent, event);
  }
}

void DemuxGetProperty(GObject* obj, guint id, GValue* value, GParamSpec* pspec) {
  auto* self = reinterpret_cast<TecheFlvDemux*>(obj);
  GST_OBJECT_LOCK(self);
  switch (id) {
    case PROP_DROPPED_FRAMES:
      g_value_set_uint64(value, self->dropped_frames);
      break;
    case PROP_RESYNCS:
      g_value_set_uint64(value, static_cast<guint64>(self->reader->resyncs()));
      break;
    case PROP_DEMUX_FORMAT:
      g_value_set_string(value, self->format_known ? flv::FormatName(self->format) : "");
      break;
    case PROP_BFRAMES:
      g_value_set_boolean(value, self->warned_bframes);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID(obj, id, pspec);
  }
  GST_OBJECT_UNLOCK(self);
}

void DemuxFinalize(GObject* obj) {
  auto* self = reinterpret_cast<TecheFlvDemux*>(obj);
  delete self->reader;
  delete self->hvcc;
  G_OBJECT_CLASS(ainvr_flv_demux_parent_class)->finalize(obj);
}

void ainvr_flv_demux_class_init(TecheFlvDemuxClass* klass) {
  auto* gobject = G_OBJECT_CLASS(klass);
  auto* element = GST_ELEMENT_CLASS(klass);
  gobject->get_property = DemuxGetProperty;
  gobject->finalize = DemuxFinalize;
  g_object_class_install_property(
      gobject, PROP_DROPPED_FRAMES,
      g_param_spec_uint64("dropped-frames", "Dropped frames", "丢弃的帧数(损坏、序列头之前、参考链断后等 IDR 期间)", 0, G_MAXUINT64, 0,
                          G_PARAM_READABLE));
  g_object_class_install_property(
      gobject, PROP_RESYNCS,
      g_param_spec_uint64("resyncs", "Resyncs", "FLV 重同步次数", 0, G_MAXUINT64, 0, G_PARAM_READABLE));
  g_object_class_install_property(
      gobject, PROP_DEMUX_FORMAT,
      g_param_spec_string("format", "Format", "输入 FLV 的 HEVC 写法(codec12/enhanced)", "", G_PARAM_READABLE));
  g_object_class_install_property(
      gobject, PROP_BFRAMES,
      g_param_spec_boolean("b-frames", "B-frames", "源含 B 帧(见过 CTS≠0 的帧)", FALSE, G_PARAM_READABLE));
  gst_element_class_set_static_metadata(element, "AINVR FLV H.265 demuxer", "Codec/Demuxer",
                                        "codec12 / Enhanced RTMP 的 FLV → H.265 hvc1 AU", "AINVR");
  gst_element_class_add_static_pad_template(element, &demux_sink_tmpl);
  gst_element_class_add_static_pad_template(element, &demux_src_tmpl);
}

void ainvr_flv_demux_init(TecheFlvDemux* self) {
  self->sinkpad = gst_pad_new_from_static_template(&demux_sink_tmpl, "sink");
  gst_pad_set_chain_function(self->sinkpad, DemuxChain);
  gst_pad_set_event_function(self->sinkpad, DemuxSinkEvent);
  gst_element_add_pad(GST_ELEMENT(self), self->sinkpad);
  self->srcpad = gst_pad_new_from_static_template(&demux_src_tmpl, "src");
  gst_pad_use_fixed_caps(self->srcpad);
  gst_element_add_pad(GST_ELEMENT(self), self->srcpad);
  self->reader = new flv::TagReader();
  self->hvcc = new std::vector<uint8_t>();
  self->length_size = 4;
  self->dropped_frames = 0;
  self->warned_bframes = false;
  self->format = HevcFlvFormat::kCodec12;
  self->format_known = false;
  DemuxResetState(self);
}

// ============================================================================
// ainvrflvmux
// ============================================================================

struct TecheFlvMux {
  GstElement parent;
  GstPad* sinkpad;
  GstPad* srcpad;
  HevcFlvFormat format;
  std::vector<uint8_t>* hvcc;
  int length_size;
  double width, height, fps;
  bool started;       // 已输出起始序列(FLV 头/元数据/序列头)
  bool pending_seq;   // caps 里的 hvcC 变了:下一个 IDR 前补发序列头
  bool caps_sent;
  guint64 frames;
};

struct TecheFlvMuxClass {
  GstElementClass parent_class;
};

enum { PROP_MUX_0, PROP_MUX_FORMAT, PROP_FRAMES };

GType ainvr_flv_mux_get_type();
G_DEFINE_TYPE(TecheFlvMux, ainvr_flv_mux, GST_TYPE_ELEMENT)

GstStaticPadTemplate mux_sink_tmpl = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS,
    GST_STATIC_CAPS("video/x-h265, stream-format=(string)hvc1, alignment=(string)au"));
GstStaticPadTemplate mux_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS("video/x-flv"));

GstFlowReturn MuxPushBytes(TecheFlvMux* self, const std::vector<uint8_t>& bytes, GstClockTime ts,
                           bool delta) {
  GstBuffer* b = NewBuffer(bytes);
  GST_BUFFER_PTS(b) = ts;
  GST_BUFFER_DTS(b) = ts;
  if (delta) GST_BUFFER_FLAG_SET(b, GST_BUFFER_FLAG_DELTA_UNIT);
  return gst_pad_push(self->srcpad, b);
}

gboolean MuxSinkEvent(GstPad* pad, GstObject* parent, GstEvent* event) {
  auto* self = reinterpret_cast<TecheFlvMux*>(parent);
  switch (GST_EVENT_TYPE(event)) {
    case GST_EVENT_CAPS: {
      GstCaps* caps = nullptr;
      gst_event_parse_caps(event, &caps);
      GstStructure* s = gst_caps_get_structure(caps, 0);
      const GValue* cd = gst_structure_get_value(s, "codec_data");
      if (!cd || !GST_VALUE_HOLDS_BUFFER(cd)) {
        gst_event_unref(event);
        GST_ELEMENT_ERROR(self, STREAM, FORMAT, ("H.265 caps 缺少 codec_data(hvcC)"), (nullptr));
        return FALSE;
      }
      GstMapInfo m;
      std::vector<uint8_t> hvcc;
      if (gst_buffer_map(gst_value_get_buffer(cd), &m, GST_MAP_READ)) {
        hvcc.assign(m.data, m.data + m.size);
        gst_buffer_unmap(gst_value_get_buffer(cd), &m);
      }
      flv::HvccInfo info;
      std::string err;
      if (!flv::ParseHvcc(hvcc.data(), hvcc.size(), &info, &err)) {
        gst_event_unref(event);
        GST_ELEMENT_ERROR(self, STREAM, FORMAT, ("H.265 codec_data 无效:%s", err.c_str()), (nullptr));
        return FALSE;
      }
      hvcc = std::move(info.normalized);
      int w = 0, h = 0, fn = 0, fd = 1;
      gst_structure_get_int(s, "width", &w);
      gst_structure_get_int(s, "height", &h);
      if (gst_structure_get_fraction(s, "framerate", &fn, &fd) && fd > 0) self->fps = double(fn) / fd;
      self->width = w;
      self->height = h;
      if (!self->hvcc->empty() && *self->hvcc != hvcc) self->pending_seq = true;
      *self->hvcc = std::move(hvcc);
      self->length_size = info.length_size;
      gst_event_unref(event);
      if (self->caps_sent) return TRUE;
      self->caps_sent = true;
      gchar* sid = gst_pad_create_stream_id(self->srcpad, GST_ELEMENT(self), nullptr);
      gst_pad_push_event(self->srcpad, gst_event_new_stream_start(sid));
      g_free(sid);
      GstCaps* out = gst_caps_new_empty_simple("video/x-flv");
      bool ok = gst_pad_push_event(self->srcpad, gst_event_new_caps(out));
      gst_caps_unref(out);
      GstSegment seg;
      gst_segment_init(&seg, GST_FORMAT_TIME);
      gst_pad_push_event(self->srcpad, gst_event_new_segment(&seg));
      return ok;
    }
    case GST_EVENT_SEGMENT:
    case GST_EVENT_STREAM_START:
      gst_event_unref(event);
      return TRUE;
    case GST_EVENT_FLUSH_STOP:
      self->started = false;  // 重新从 IDR + 起始序列开始
      return gst_pad_event_default(pad, parent, event);
    default:
      return gst_pad_event_default(pad, parent, event);
  }
}

GstFlowReturn MuxChain(GstPad*, GstObject* parent, GstBuffer* buffer) {
  auto* self = reinterpret_cast<TecheFlvMux*>(parent);
  if (self->hvcc->empty()) {
    gst_buffer_unref(buffer);
    GST_ELEMENT_ERROR(self, CORE, NEGOTIATION, ("ainvrflvmux 未收到 H.265 caps"), (nullptr));
    return GST_FLOW_NOT_NEGOTIATED;
  }
  GstMapInfo m;
  if (!gst_buffer_map(buffer, &m, GST_MAP_READ)) {
    gst_buffer_unref(buffer);
    return GST_FLOW_OK;
  }
  std::vector<uint8_t> data(m.data, m.data + m.size);
  gst_buffer_unmap(buffer, &m);
  GstClockTime dts = GST_BUFFER_DTS_IS_VALID(buffer) ? GST_BUFFER_DTS(buffer) : GST_BUFFER_PTS(buffer);
  GstClockTime pts = GST_BUFFER_PTS_IS_VALID(buffer) ? GST_BUFFER_PTS(buffer) : dts;
  gst_buffer_unref(buffer);
  if (!GST_CLOCK_TIME_IS_VALID(dts) || !flv::LengthPrefixedValid(data.data(), data.size(), self->length_size)) {
    return GST_FLOW_OK;  // 无时间戳或损坏的帧不能写出去
  }
  const bool idr = flv::LengthPrefixedIsIdr(data.data(), data.size(), self->length_size);
  if (!self->started && !idr) return GST_FLOW_OK;  // 第一个 IDR 之前不输出
  const uint32_t dts_ms = static_cast<uint32_t>(dts / GST_MSECOND);
  const int32_t cts_ms = static_cast<int32_t>((static_cast<int64_t>(pts) - static_cast<int64_t>(dts)) / GST_MSECOND);
  GstFlowReturn r = GST_FLOW_OK;
  if (!self->started) {
    self->started = true;
    self->pending_seq = true;
    r = MuxPushBytes(self, flv::BuildFlvHeader(), dts, false);
    if (r == GST_FLOW_OK) {
      r = MuxPushBytes(self, flv::BuildMetadataTag(self->width, self->height, self->fps, self->format), dts, false);
    }
  }
  if (r == GST_FLOW_OK && self->pending_seq && idr) {
    self->pending_seq = false;
    r = MuxPushBytes(self,
                     flv::BuildVideoTag(self->format, VideoPacket::Kind::kSequenceHeader, true, dts_ms, 0,
                                        self->hvcc->data(), self->hvcc->size()),
                     dts, false);
  }
  if (r != GST_FLOW_OK) return r;
  self->frames++;
  return MuxPushBytes(
      self, flv::BuildVideoTag(self->format, VideoPacket::Kind::kFrame, idr, dts_ms, cts_ms, data.data(), data.size()),
      dts, !idr);
}

void MuxSetProperty(GObject* obj, guint id, const GValue* value, GParamSpec* pspec) {
  auto* self = reinterpret_cast<TecheFlvMux*>(obj);
  if (id == PROP_MUX_FORMAT) {
    const gchar* s = g_value_get_string(value);
    auto f = flv::ParseFormatName(s ? s : "");
    if (f) self->format = *f;
    else g_warning("ainvrflvmux: 未知 format '%s',保持 %s", s ? s : "", flv::FormatName(self->format));
    return;
  }
  G_OBJECT_WARN_INVALID_PROPERTY_ID(obj, id, pspec);
}

void MuxGetProperty(GObject* obj, guint id, GValue* value, GParamSpec* pspec) {
  auto* self = reinterpret_cast<TecheFlvMux*>(obj);
  switch (id) {
    case PROP_MUX_FORMAT:
      g_value_set_string(value, flv::FormatName(self->format));
      break;
    case PROP_FRAMES:
      g_value_set_uint64(value, self->frames);
      break;
    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID(obj, id, pspec);
  }
}

void MuxFinalize(GObject* obj) {
  delete reinterpret_cast<TecheFlvMux*>(obj)->hvcc;
  G_OBJECT_CLASS(ainvr_flv_mux_parent_class)->finalize(obj);
}

void ainvr_flv_mux_class_init(TecheFlvMuxClass* klass) {
  auto* gobject = G_OBJECT_CLASS(klass);
  auto* element = GST_ELEMENT_CLASS(klass);
  gobject->set_property = MuxSetProperty;
  gobject->get_property = MuxGetProperty;
  gobject->finalize = MuxFinalize;
  g_object_class_install_property(
      gobject, PROP_MUX_FORMAT,
      g_param_spec_string("format", "Format", "输出 FLV 的 HEVC 写法:codec12(默认)/ enhanced", "codec12",
                          static_cast<GParamFlags>(G_PARAM_READWRITE | GST_PARAM_MUTABLE_READY)));
  g_object_class_install_property(
      gobject, PROP_FRAMES,
      g_param_spec_uint64("frames", "Frames", "已输出的帧数", 0, G_MAXUINT64, 0, G_PARAM_READABLE));
  gst_element_class_set_static_metadata(element, "AINVR FLV H.265 muxer", "Codec/Muxer",
                                        "H.265 hvc1 AU → codec12 / Enhanced RTMP 的 FLV tag", "AINVR");
  gst_element_class_add_static_pad_template(element, &mux_sink_tmpl);
  gst_element_class_add_static_pad_template(element, &mux_src_tmpl);
}

void ainvr_flv_mux_init(TecheFlvMux* self) {
  self->sinkpad = gst_pad_new_from_static_template(&mux_sink_tmpl, "sink");
  gst_pad_set_chain_function(self->sinkpad, MuxChain);
  gst_pad_set_event_function(self->sinkpad, MuxSinkEvent);
  gst_element_add_pad(GST_ELEMENT(self), self->sinkpad);
  self->srcpad = gst_pad_new_from_static_template(&mux_src_tmpl, "src");
  gst_pad_use_fixed_caps(self->srcpad);
  gst_element_add_pad(GST_ELEMENT(self), self->srcpad);
  self->format = HevcFlvFormat::kCodec12;
  self->hvcc = new std::vector<uint8_t>();
  self->length_size = 4;
  self->width = self->height = 0;
  self->fps = 0;
  self->started = false;
  self->pending_seq = false;
  self->caps_sent = false;
  self->frames = 0;
}

}  // namespace

bool RegisterTecheFlvElements() {
  static std::once_flag once;
  static bool ok = false;
  std::call_once(once, [] {
    gst_init(nullptr, nullptr);
    ok = gst_element_register(nullptr, "ainvrflvdemux", GST_RANK_NONE, ainvr_flv_demux_get_type()) &&
         gst_element_register(nullptr, "ainvrflvmux", GST_RANK_NONE, ainvr_flv_mux_get_type());
  });
  return ok;
}

}  // namespace ai_service::stream

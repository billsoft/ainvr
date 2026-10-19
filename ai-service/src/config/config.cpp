// Copyright AINVR. Adapted for the S100P service.
#include "config.hpp"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <filesystem>
#include <set>
#include <sstream>
#include <stdexcept>

#include <nlohmann/json.hpp>
#include <yaml-cpp/yaml.h>

#include "yaml_json.hpp"

namespace ai_service::config {

namespace {

using nlohmann::json;

// ---- extra=forbid 语义:未知字段直接拒绝 ----
//
// known: 结构体真正建模的字段名。dead: 已知但不建模的死字段(OSD 画框、
// sei.match_window_ms、preprocess.ai_sample_width/height 之类)——允许
// 出现在 JSON 里(否则旧 config_overlay.json 加载失败),但值不落进结构体。
void RejectUnknownFields(const json& node, const std::set<std::string>& known,
                          const std::set<std::string>& dead, const std::string& context) {
  if (!node.is_object()) return;
  for (auto it = node.begin(); it != node.end(); ++it) {
    const std::string& key = it.key();
    if (known.count(key) || dead.count(key)) continue;
    throw ConfigValidationError(context + ": 不支持的字段 '" + key + "'");
  }
}

double GetD(const json& node, const char* key, double fallback) {
  if (node.contains(key) && !node[key].is_null()) return node[key].get<double>();
  return fallback;
}
int GetI(const json& node, const char* key, int fallback) {
  if (node.contains(key) && !node[key].is_null()) return node[key].get<int>();
  return fallback;
}
bool GetB(const json& node, const char* key, bool fallback) {
  if (node.contains(key) && !node[key].is_null()) return node[key].get<bool>();
  return fallback;
}
std::string GetS(const json& node, const char* key, const std::string& fallback) {
  if (node.contains(key) && !node[key].is_null()) return node[key].get<std::string>();
  return fallback;
}
std::optional<std::string> GetOptS(const json& node, const char* key) {
  if (node.contains(key) && !node[key].is_null()) return node[key].get<std::string>();
  return std::nullopt;
}

[[noreturn]] void Fail(const std::string& msg) { throw ConfigValidationError(msg); }

// ---- 各子结构的解析 + 校验(逐条对应 config.py 的 field_validator /
// model_validator) ----

ReconnectConfig ParseReconnect(const json& node) {
  ReconnectConfig r;
  if (node.is_null()) return r;
  RejectUnknownFields(node, {"enabled", "initial_delay", "max_delay", "backoff_factor"}, {},
                       "reconnect");
  r.enabled = GetB(node, "enabled", r.enabled);
  r.initial_delay = GetD(node, "initial_delay", r.initial_delay);
  r.max_delay = GetD(node, "max_delay", r.max_delay);
  r.backoff_factor = GetD(node, "backoff_factor", r.backoff_factor);
  return r;
}

StreamConfig ParseStream(const json& node) {
  StreamConfig s;
  if (node.is_null() || !node.contains("url")) {
    Fail("stream.url 缺失(必填字段,没有默认值)");
  }
  RejectUnknownFields(node, {"url", "protocol", "watchdog_timeout_seconds", "reconnect", "codec_override"},
                       {}, "stream");
  s.url = node["url"].get<std::string>();
  if (s.url.empty()) Fail("stream.url 不能为空");
  if (s.url.rfind("rtmp://", 0) != 0 && s.url.rfind("http://", 0) != 0 &&
      s.url.rfind("https://", 0) != 0) {
    Fail("stream.url 必须以 rtmp:// / http:// / https:// 开头,当前: " + s.url);
  }
  s.protocol = GetS(node, "protocol", s.protocol);
  if (s.protocol != "rtmp" && s.protocol != "flv" && s.protocol != "auto") {
    Fail("stream.protocol 必须是 rtmp/flv/auto 之一,当前: " + s.protocol);
  }
  s.watchdog_timeout_seconds =
      GetD(node, "watchdog_timeout_seconds", s.watchdog_timeout_seconds);
  s.reconnect = ParseReconnect(node.value("reconnect", json()));
  s.codec_override = GetOptS(node, "codec_override");
  if (s.codec_override && *s.codec_override != "h264" && *s.codec_override != "h265") {
    Fail("stream.codec_override 只能是 h264/h265,当前: " + *s.codec_override);
  }
  return s;
}

// Configuration declares the execution contract; actual model loading and
// capability checks remain mandatory before starting a channel.
void ValidateAdapterProviderCombo(const std::string& adapter, const std::string& provider) {
  bool bpu=adapter.ends_with("_bpu");
  if((bpu&&provider!="bpu")||(!bpu&&provider!="cpu"))
    Fail("model.adapter 与 provider 不匹配：BPU 适配器要求 bpu，ONNX 适配器要求 cpu");
}

ModelConfig ParseModel(const json& node) {
  ModelConfig m;
  if (node.is_null()) return m;
  RejectUnknownFields(node,
                       {"name", "adapter", "path", "input_size", "stride", "provider",
                        "engine_cache", "class_names", "description", "label_id", "label_name", "max_new_tokens", "prompts"},
                       {}, "model");
  m.name = GetS(node, "name", m.name);
  m.adapter = GetS(node, "adapter", m.adapter);
  static const std::set<std::string> kKnownAdapters = {
      "yolo26_end2end", "yolo26_traditional", "yolo26_bpu", "yoloface_bpu", "scrfd_bpu", "locateanything_bpu", "yoloe_bpu"};
  if (!kKnownAdapters.count(m.adapter)) {
    Fail("model.adapter 未知取值: " + m.adapter);
  }
  m.path = GetS(node, "path", m.path);
  if (node.contains("input_size") && node["input_size"].is_array()) {
    m.input_size.clear();
    for (auto&& v : node["input_size"]) m.input_size.push_back(v.get<int>());
  }
  if (m.input_size.size() != 2) {
    Fail("model.input_size 必须是 [h, w]");
  }
  if (m.input_size[0] <= 0 || m.input_size[1] <= 0) {
    Fail("model.input_size 必须为正整数");
  }
  m.stride = GetI(node, "stride", m.stride);
  if (m.stride <= 0) Fail("model.stride 必须为正整数");
  if (m.input_size[0] % m.stride != 0 || m.input_size[1] % m.stride != 0) {
    Fail("model.input_size 必须为 stride 的整数倍");
  }
  m.provider = GetS(node, "provider", m.provider);
  if (m.provider != "bpu" && m.provider != "cpu") {
    Fail("S100P model.provider 只接受 bpu/cpu；CUDA/TensorRT 模型需重新转换，当前: " + m.provider);
  }
  ValidateAdapterProviderCombo(m.adapter, m.provider);
  const auto suffix=std::filesystem::path(m.path).extension().string();
  if((m.provider=="bpu"&&suffix!=".hbm")||(m.provider=="cpu"&&suffix!=".onnx"))
    Fail("model.path 必须匹配 provider：bpu 使用 .hbm，cpu 使用 .onnx；重命名文件不能转换模型");
  m.engine_cache = GetS(node, "engine_cache", m.engine_cache);
  m.description = GetS(node, "description", "");
  m.label_id = GetS(node, "label_id", "");
  m.label_name = GetS(node, "label_name", "");
  m.max_new_tokens = GetI(node, "max_new_tokens", m.adapter == "locateanything_bpu" ? 256 : 64);
  if (node.contains("prompts") && !node["prompts"].is_null()) {
    if ((m.adapter != "yoloe_bpu" && m.adapter != "locateanything_bpu") || !node["prompts"].is_array() ||
        node["prompts"].empty() || node["prompts"].size() > (m.name=="yoloe-26x-32"?32u:8u))
      Fail("标签数量超出所选模型容量，8 槽最多 8 项、32 槽最多 32 项");
    std::set<std::string> ids, descriptions;
    for (const auto& row : node["prompts"]) {
      if (!row.is_object()) Fail("标签项必须是对象");
      RejectUnknownFields(row, {"description", "label_id", "label_name"}, {}, "model.prompts");
      PromptLabel item{GetS(row,"description",""),GetS(row,"label_id",""),GetS(row,"label_name","")};
      if (item.description.find_first_not_of(" \t\r\n") == std::string::npos || item.description.size()>640 ||
          std::any_of(item.description.begin(),item.description.end(),[](unsigned char c){return c<32||c==127||c=='<'||c=='>';}))
        Fail("每个标签必须提供有效的单行识别描述");
      if (item.label_id.empty() || item.label_id.size()>64 ||
          item.label_id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:-")!=std::string::npos ||
          !ids.insert(item.label_id).second)
        Fail("标签 ID 必须有效且不能重复");
      if (item.label_name.find_first_not_of(" \t\r\n")==std::string::npos || item.label_name.size()>192 ||
          std::any_of(item.label_name.begin(),item.label_name.end(),[](unsigned char c){return c<32||c==127||c=='<'||c=='>';}))
        Fail("每个标签必须提供有效名称");
      if (!descriptions.insert(item.description).second) Fail("识别描述不能重复");
      m.prompts.push_back(std::move(item));
    }
  }
  if ((m.adapter == "locateanything_bpu" || m.adapter == "yoloe_bpu") && m.prompts.empty()) {
    if (m.description.find_first_not_of(" \t\r\n") == std::string::npos || m.description.size() > 640 ||
        std::any_of(m.description.begin(), m.description.end(), [](unsigned char c) {
          return c < 32 || c == 127 || c == '<' || c == '>';
        }))
      Fail("开放词汇模型必须提供单行识别描述，不允许控制标记");
    if (m.label_id.empty() || m.label_id.size() > 64 ||
        m.label_id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos)
      Fail("开放词汇模型必须提供稳定标签 ID (字母、数字、下划线或短横线)");
    if (m.label_name.empty() || m.label_name.size() > 192) Fail("开放词汇模型必须提供标签名称");
    const int token_limit = m.adapter == "locateanything_bpu" ? 256 : 64;
    if (m.max_new_tokens < 1 || m.max_new_tokens > token_limit)
      Fail("开放词汇生成上限必须为 1-" + std::to_string(token_limit));
    if (m.adapter == "locateanything_bpu" &&
        (m.input_size != std::vector<int>{224, 448} || m.provider != "bpu"))
      Fail("开放词汇模型要求 224×448 BPU 输入契约，模型仍须通过编译及加载验证");
  }
  if (node.contains("class_names") && node["class_names"].is_array()) {
    std::vector<std::string> names;
    for (auto&& v : node["class_names"]) names.push_back(v.get<std::string>());
    m.class_names = std::move(names);
  }
  if (m.adapter == "yoloe_bpu" &&
      (m.provider != "bpu" || m.input_size != std::vector<int>{640, 640} || m.path.empty()))
    Fail("开放词汇高速模型要求 640×640 BPU 输入契约，模型仍须通过编译及加载验证");
  return m;
}

// preprocess.ai_sample_width/height:2026-09-10/11 两次生产画质事故后固定
// 拒绝非 0(见移植设计 §3.3)。字段允许出现在 JSON 里(兼容旧 overlay),
// 但不落进 pipeline::PreprocessConfig(v2 压根没建这两个字段)。
void ValidateAiSampleSize(const json& node) {
  int w = GetI(node, "ai_sample_width", 0);
  int h = GetI(node, "ai_sample_height", 0);
  if (w != 0 || h != 0) {
    Fail("preprocess.ai_sample_width/ai_sample_height 已停用,只接受 0/0"
         "(这个开关会让识别历史截图取自 VIC 缩放后的小图而不是真实源分辨率,"
         "喂给 AI 的分辨率始终由 model.input_size 保证,不需要这个字段)");
  }
}

pipeline::PreprocessConfig ParsePreprocess(const json& node) {
  pipeline::PreprocessConfig p;
  if (node.is_null()) return p;
  RejectUnknownFields(node,
                       {"letterbox", "padding_color", "interpolation", "normalize", "mean",
                        "std", "rgb_order", "gpu_direct"},
                       {"ai_sample_width", "ai_sample_height"}, "preprocess");
  ValidateAiSampleSize(node);
  p.letterbox = GetB(node, "letterbox", p.letterbox);
  if (node.contains("padding_color") && node["padding_color"].is_array()) {
    if (node["padding_color"].size() != 3) Fail("preprocess.padding_color 必须是 [r,g,b] 三通道");
    for (int i = 0; i < 3; ++i) {
      int c = node["padding_color"][i].get<int>();
      if (c < 0 || c > 255) Fail("preprocess.padding_color 取值范围 0-255");
      p.padding_color[i] = c;
    }
  }
  p.interpolation = GetS(node, "interpolation", p.interpolation);
  static const std::set<std::string> kInterp = {"nearest", "bilinear", "bicubic", "area",
                                                 "lanczos4"};
  if (!kInterp.count(p.interpolation)) {
    Fail("preprocess.interpolation 未知取值: " + p.interpolation);
  }
  p.normalize = GetB(node, "normalize", p.normalize);
  if (node.contains("mean") && node["mean"].is_array() && node["mean"].size() == 3) {
    for (int i = 0; i < 3; ++i) p.mean[i] = node["mean"][i].get<double>();
  }
  if (node.contains("std") && node["std"].is_array() && node["std"].size() == 3) {
    for (int i = 0; i < 3; ++i) p.std[i] = node["std"][i].get<double>();
  }
  p.rgb_order = GetB(node, "rgb_order", p.rgb_order);
  p.normalization_explicit = node.contains("normalize") || node.contains("mean") ||
                             node.contains("std") || node.contains("rgb_order");
  // gpu_direct:已废弃。所有模型都走 GPU 直写模型输入,旧配置里的这个键
  // 仍接受(生产 overlay 里有),不再有任何作用。
  return p;
}

PostprocessConfig ParsePostprocess(const json& node) {
  PostprocessConfig p;
  if (node.is_null()) return p;
  RejectUnknownFields(node, {"conf_threshold", "iou_threshold", "max_detections"}, {},
                       "postprocess");
  p.conf_threshold = GetD(node, "conf_threshold", p.conf_threshold);
  p.iou_threshold = GetD(node, "iou_threshold", p.iou_threshold);
  if (p.conf_threshold < 0.0 || p.conf_threshold > 1.0) {
    Fail("postprocess.conf_threshold 必须在 [0,1] 之间");
  }
  if (p.iou_threshold < 0.0 || p.iou_threshold > 1.0) {
    Fail("postprocess.iou_threshold 必须在 [0,1] 之间");
  }
  p.max_detections = GetI(node, "max_detections", p.max_detections);
  return p;
}

ResultBufferConfig ParseResultBuffer(const json& node) {
  ResultBufferConfig r;
  if (node.is_null()) return r;
  RejectUnknownFields(node, {"max_frames"}, {}, "result_buffer");
  r.max_frames = GetI(node, "max_frames", r.max_frames);
  return r;
}

SeiConfig ParseSei(const json& node) {
  SeiConfig s;
  if (node.is_null()) return s;
  // match_window_ms 死字段(2026-09-17 三方解耦重构后无消费方),format 字段
  // 目前唯一合法值是 "json",占位声明,传别的值直接拒绝(config.py 原有的
  // Literal["json"] 约束)。
  RejectUnknownFields(node, {"max_payload_bytes", "format"}, {"match_window_ms"}, "publish.sei");
  s.max_payload_bytes = GetI(node, "max_payload_bytes", s.max_payload_bytes);
  if (s.max_payload_bytes < 256 || s.max_payload_bytes > 4096) {
    Fail("publish.sei.max_payload_bytes 必须在 [256,4096] 之间");
  }
  std::string format = GetS(node, "format", "json");
  if (format != "json") Fail("publish.sei.format 目前只支持 json");
  return s;
}

PublishConfig ParsePublish(const json& node) {
  PublishConfig p;
  if (node.is_null()) return p;
  RejectUnknownFields(node,
                       {"enabled", "mode", "rtmp_base", "target_url",
                        "watchdog_timeout_seconds", "srs_api_base", "flv_format", "reconnect", "sei"},
                       {"osd"}, "publish");
  p.enabled = GetB(node, "enabled", p.enabled);
  std::string mode = GetS(node, "mode", p.mode);
  // 历史值 osd_encode(已下线)静默改写成 passthrough_sei——不能直接拒绝,
  // 否则带着旧配置的通道会直接起不来(config.py 原有的 before-validator)。
  if (mode == "osd_encode") mode = "passthrough_sei";
  if (mode != "passthrough_sei") Fail("publish.mode 目前只支持 passthrough_sei");
  p.mode = mode;
  p.rtmp_base = GetS(node, "rtmp_base", p.rtmp_base);
  p.target_url = GetOptS(node, "target_url");
  p.watchdog_timeout_seconds =
      GetD(node, "watchdog_timeout_seconds", p.watchdog_timeout_seconds);
  p.srs_api_base = GetS(node, "srs_api_base", p.srs_api_base);
  p.flv_format = GetS(node, "flv_format", p.flv_format);
  if (p.flv_format != "codec12" && p.flv_format != "enhanced") {
    Fail("publish.flv_format 只能是 codec12/enhanced,当前: " + p.flv_format);
  }
  p.reconnect = ParseReconnect(node.value("reconnect", json()));
  p.sei = ParseSei(node.value("sei", json()));
  // osd 死配置:允许出现,不解析出有意义的值(见 config.hpp 头注)。
  return p;
}

// snapshot.face_enhance_enabled(bool,已废弃 2026-09 前的开关)→
// face_enhance_model 迁移。显式给了 face_enhance_model 时以新字段为准
// (config.py 原有的 _migrate_face_enhance_enabled)。
std::string MigrateFaceEnhanceModel(const json& node) {
  if (node.contains("face_enhance_model") && !node["face_enhance_model"].is_null()) {
    return node["face_enhance_model"].get<std::string>();
  }
  bool legacy_enabled = GetB(node, "face_enhance_enabled", false);
  return legacy_enabled ? "gpen" : "none";
}

SnapshotConfig ParseSnapshot(const json& node) {
  SnapshotConfig s;
  if (node.is_null()) return s;
  RejectUnknownFields(node,
                       {"enabled", "max_count", "min_interval_ms", "jpeg_quality",
                        "max_crop_dimension", "padding_ratio", "projection_mode",
                        "brightness_enabled", "brightness_target", "face_enhance_model",
                        "face_enhance_blend"},
                       {"face_enhance_enabled"}, "snapshot");
  s.enabled = GetB(node, "enabled", s.enabled);
  s.max_count = GetI(node, "max_count", s.max_count);
  if (s.max_count <= 0) Fail("snapshot.max_count 必须为正整数");
  s.min_interval_ms = GetI(node, "min_interval_ms", s.min_interval_ms);
  if (s.min_interval_ms < 0) Fail("snapshot.min_interval_ms 不能为负数");
  // Legacy files remain loadable, but archive sampling is no longer a mode.
  s.min_interval_ms = 0;
  s.jpeg_quality = GetI(node, "jpeg_quality", s.jpeg_quality);
  if (s.jpeg_quality < 1 || s.jpeg_quality > 100) Fail("snapshot.jpeg_quality 必须在 [1,100] 之间");
  s.max_crop_dimension = GetI(node, "max_crop_dimension", s.max_crop_dimension);
  if (s.max_crop_dimension <= 0 || s.max_crop_dimension > 4096)
    Fail("snapshot.max_crop_dimension 必须在 [1,4096] 之间");
  s.padding_ratio = GetD(node, "padding_ratio", s.padding_ratio);
  if (s.padding_ratio < 0.0 || s.padding_ratio > 1.0) Fail("snapshot.padding_ratio 必须在 [0,1] 之间");
  s.projection_mode = GetS(node, "projection_mode", s.projection_mode);
  if (s.projection_mode != "none" && s.projection_mode != "erp_equirect") {
    Fail("snapshot.projection_mode 必须是 none/erp_equirect 之一");
  }
  // At 1.5x supersampling, a 1280-square crop needs <32 MiB of float maps.
  // Reject unsupported settings at the shared load/create/update boundary.
  if (s.projection_mode == "erp_equirect" && s.max_crop_dimension > 1280) {
    Fail("全景截图 snapshot.max_crop_dimension 必须在 [1,1280] 之间；请降低截图尺寸");
  }
  s.brightness_enabled = GetB(node, "brightness_enabled", s.brightness_enabled);
  s.brightness_target = GetI(node, "brightness_target", s.brightness_target);
  if (s.brightness_target < 0 || s.brightness_target > 255) {
    Fail("snapshot.brightness_target 必须在 [0,255] 之间");
  }
  s.face_enhance_model = MigrateFaceEnhanceModel(node);
  if (s.face_enhance_model != "none" && s.face_enhance_model != "gpen" &&
      s.face_enhance_model != "codeformer") {
    Fail("snapshot.face_enhance_model 必须是 none/gpen/codeformer 之一");
  }
  s.face_enhance_blend = GetD(node, "face_enhance_blend", s.face_enhance_blend);
  if (s.face_enhance_blend < 0.0 || s.face_enhance_blend > 1.0) {
    Fail("snapshot.face_enhance_blend 必须在 [0,1] 之间");
  }
  return s;
}

// ChannelConfig 级联校验(config.py::validate_publish_requires_rtmp):
// publish.enabled=true 时,源必须是 rtmp://(ES 分流管线硬依赖 rtmpsrc),
// 且必须显式给 target_url(rtmp:// 地址),不允许自动派生。
void ValidatePublishRequiresRtmp(const ChannelConfig& c) {
  if (!c.publish.enabled) return;
  if (c.stream.url.rfind("rtmp://", 0) != 0) {
    Fail("publish.enabled=true 时 stream.url 必须是 rtmp://(ES 分流管线硬依赖 rtmpsrc),当前: " +
         c.stream.url);
  }
  if (!c.publish.target_url.has_value() || c.publish.target_url->empty()) {
    Fail("publish.enabled=true 时必须指定 target_url(推流目标地址),不允许留空自动派生");
  }
  if (c.publish.target_url->rfind("rtmp://", 0) != 0) {
    Fail("publish.target_url 必须是 rtmp:// 地址,当前: " + *c.publish.target_url);
  }
}

}  // namespace

ChannelConfig ChannelConfigFromJson(const json& node) {
  ChannelConfig c;
  if (!node.contains("id")) Fail("channel.id 缺失(必填字段,没有默认值)");
  RejectUnknownFields(node,
                       {"id", "name", "enabled", "deletion_pending", "manually_stopped", "stream", "inference_fps",
                        "max_consecutive_failures", "model", "preprocess", "postprocess",
                        "result_buffer", "publish", "snapshot"},
                       {}, "channel");
  c.id = node["id"].get<std::string>();
  c.name = GetS(node, "name", c.name);
  c.enabled = GetB(node, "enabled", c.enabled);
  c.deletion_pending = GetB(node, "deletion_pending", false);
  c.manually_stopped = GetB(node, "manually_stopped", false);
  c.stream = ParseStream(node.value("stream", json()));
  c.inference_fps = GetD(node, "inference_fps", c.inference_fps);
  // 0 = 跟随源流。最低每小时一帧;推理线程按短片段等待,停止和热更新不会被长间隔卡住。
  if (!std::isfinite(c.inference_fps) || c.inference_fps < 0.0 ||
      (c.inference_fps > 0.0 && c.inference_fps < 1.0 / 3600.0)) {
    Fail("inference_fps 必须为 0 或 >= 1/3600");
  }
  c.max_consecutive_failures =
      GetI(node, "max_consecutive_failures", c.max_consecutive_failures);
  c.model = ParseModel(node.value("model", json()));
  if (c.model.adapter != "locateanything_bpu" && c.inference_fps > 0 && c.inference_fps < 0.1)
    Fail("固定类别模型的推理帧率不能低于 0.1");
  if (c.model.adapter == "locateanything_bpu" && (c.inference_fps <= 0 || c.inference_fps > 1.0))
    Fail("开放词汇模型采集间隔须为 1-3600 秒，不支持跟随源流");
  c.preprocess = ParsePreprocess(node.value("preprocess", json()));
  c.postprocess = ParsePostprocess(node.value("postprocess", json()));
  if (c.postprocess.max_detections < 1 || c.postprocess.max_detections > 1000 ||
      (c.model.adapter == "yoloe_bpu" && c.postprocess.max_detections > 300))
    Fail("最大检测数超出所选模型范围（高速开放词汇模型为 1-300，其他模型为 1-1000）");
  c.result_buffer = ParseResultBuffer(node.value("result_buffer", json()));
  c.publish = ParsePublish(node.value("publish", json()));
  c.snapshot = ParseSnapshot(node.value("snapshot", json()));
  ValidatePublishRequiresRtmp(c);
  return c;
}

namespace {

ServerConfig ParseServer(const json& node) {
  ServerConfig s;
  if (node.is_null()) return s;
  // ServerConfig 不做 extra=forbid(config.py 原有例外——server.* 没有代码
  // 路径把它直接暴露给 API patch,PUT /api/v1/config 对 server.* 一律 409)。
  s.host = GetS(node, "host", s.host);
  s.port = GetI(node, "port", s.port);
  s.log_level = GetS(node, "log_level", s.log_level);
  static const std::set<std::string> kLevels = {"debug", "info", "warning", "error"};
  if (!kLevels.count(s.log_level)) Fail("server.log_level 必须是 debug/info/warning/error 之一");
  s.api_key = GetOptS(node, "api_key");
  return s;
}

SnapshotStoreConfig ParseSnapshotStore(const json& node) {
  SnapshotStoreConfig s;
  if (node.is_null()) return s;
  RejectUnknownFields(node,
                       {"mongo_uri", "db_name", "mongo_readonly_username",
                        "mongo_readonly_password", "mongo_host", "mongo_port",
                        "face_enhance_engine", "face_enhance_codeformer_engine"},
                       {}, "snapshot_store");
  s.mongo_uri = GetS(node, "mongo_uri", s.mongo_uri);
  s.db_name = GetS(node, "db_name", s.db_name);
  s.mongo_readonly_username = GetOptS(node, "mongo_readonly_username");
  s.mongo_readonly_password = GetOptS(node, "mongo_readonly_password");
  s.mongo_host = GetS(node, "mongo_host", s.mongo_host);
  s.mongo_port = GetI(node, "mongo_port", s.mongo_port);
  s.face_enhance_engine = GetS(node, "face_enhance_engine", s.face_enhance_engine);
  s.face_enhance_codeformer_engine =
      GetS(node, "face_enhance_codeformer_engine", s.face_enhance_codeformer_engine);
  return s;
}

}  // namespace

AppConfig AppConfigFromJson(const json& root) {
  AppConfig cfg;
  // AppConfig 顶层同样不做 extra=forbid(config.py 原有例外,理由同 ServerConfig)。
  cfg.server = ParseServer(root.value("server", json()));
  cfg.snapshot_store = ParseSnapshotStore(root.value("snapshot_store", json()));
  if (root.contains("channels") && root["channels"].is_array()) {
    for (auto&& ch : root["channels"]) {
      cfg.channels.push_back(ChannelConfigFromJson(ch));
    }
  }
  std::set<std::string> ids;
  for (auto&& c : cfg.channels) {
    if (!ids.insert(c.id).second) Fail("channel id 重复: " + c.id);
  }
  return cfg;
}

AppConfig LoadAppConfig(const std::string& path) {
  YAML::Node root = YAML::LoadFile(path);  // 文件不存在/语法错误会抛 YAML::Exception
  json j = YamlToJson(root);
  if (j.is_null()) j = json::object();
  return AppConfigFromJson(j);
}

// ---- 序列化方向:结构体 -> JSON,供 control_server 的 GET 系列响应体用 ----

nlohmann::json ChannelConfigToJson(const ChannelConfig& c, bool include_id) {
  json j;
  if (include_id) j["id"] = c.id;
  j["name"] = c.name;
  j["enabled"] = c.enabled;
  if (c.deletion_pending) j["deletion_pending"] = true;
  if (c.manually_stopped) j["manually_stopped"] = true;
  j["stream"] = {
      {"url", c.stream.url},
      {"protocol", c.stream.protocol},
      {"watchdog_timeout_seconds", c.stream.watchdog_timeout_seconds},
      {"reconnect",
       {
           {"enabled", c.stream.reconnect.enabled},
           {"initial_delay", c.stream.reconnect.initial_delay},
           {"max_delay", c.stream.reconnect.max_delay},
           {"backoff_factor", c.stream.reconnect.backoff_factor},
       }},
  };
  if (c.stream.codec_override) j["stream"]["codec_override"] = *c.stream.codec_override;
  j["inference_fps"] = c.inference_fps;
  j["max_consecutive_failures"] = c.max_consecutive_failures;
  j["model"] = {
      {"name", c.model.name},
      {"adapter", c.model.adapter},
      {"path", c.model.path},
      {"input_size", c.model.input_size},
      {"stride", c.model.stride},
      {"provider", c.model.provider},
      {"engine_cache", c.model.engine_cache},
  };
  j["model"]["class_names"] = c.model.class_names.has_value()
                                   ? json(*c.model.class_names)
                                   : json(nullptr);
  if (c.model.adapter == "locateanything_bpu" || c.model.adapter == "yoloe_bpu") {
    j["model"]["description"] = c.model.description;
    j["model"]["label_id"] = c.model.label_id;
    j["model"]["label_name"] = c.model.label_name;
    j["model"]["max_new_tokens"] = c.model.max_new_tokens;
    if (!c.model.prompts.empty()) {
      j["model"]["prompts"] = json::array();
      for (const auto& row : c.model.prompts)
        j["model"]["prompts"].push_back({{"description",row.description},{"label_id",row.label_id},{"label_name",row.label_name}});
    }
  }
  j["preprocess"] = {
      {"letterbox", c.preprocess.letterbox},
      {"padding_color", c.preprocess.padding_color},
      {"interpolation", c.preprocess.interpolation},
      {"normalize", c.preprocess.normalize},
      {"mean", c.preprocess.mean},
      {"std", c.preprocess.std},
      {"rgb_order", c.preprocess.rgb_order},
  };
  j["postprocess"] = {
      {"conf_threshold", c.postprocess.conf_threshold},
      {"iou_threshold", c.postprocess.iou_threshold},
      {"max_detections", c.postprocess.max_detections},
  };
  j["result_buffer"] = {{"max_frames", c.result_buffer.max_frames}};
  j["publish"] = {
      {"enabled", c.publish.enabled},
      {"mode", c.publish.mode},
      {"rtmp_base", c.publish.rtmp_base},
      {"watchdog_timeout_seconds", c.publish.watchdog_timeout_seconds},
      {"srs_api_base", c.publish.srs_api_base},
      {"flv_format", c.publish.flv_format},
      {"reconnect",
       {
           {"enabled", c.publish.reconnect.enabled},
           {"initial_delay", c.publish.reconnect.initial_delay},
           {"max_delay", c.publish.reconnect.max_delay},
           {"backoff_factor", c.publish.reconnect.backoff_factor},
       }},
      {"sei", {{"max_payload_bytes", c.publish.sei.max_payload_bytes}}},
  };
  j["publish"]["target_url"] =
      c.publish.target_url.has_value() ? json(*c.publish.target_url) : json(nullptr);
  j["snapshot"] = {
      {"enabled", c.snapshot.enabled},
      {"max_count", c.snapshot.max_count},
      {"min_interval_ms", c.snapshot.min_interval_ms},
      {"jpeg_quality", c.snapshot.jpeg_quality},
      {"max_crop_dimension", c.snapshot.max_crop_dimension},
      {"padding_ratio", c.snapshot.padding_ratio},
      {"projection_mode", c.snapshot.projection_mode},
      {"brightness_enabled", c.snapshot.brightness_enabled},
      {"brightness_target", c.snapshot.brightness_target},
      {"face_enhance_model", c.snapshot.face_enhance_model},
      {"face_enhance_blend", c.snapshot.face_enhance_blend},
  };
  return j;
}

nlohmann::json ServerConfigToJson(const ServerConfig& c) {
  return json{
      {"host", c.host},
      {"port", c.port},
      {"log_level", c.log_level},
      {"api_key_set", c.api_key.has_value()},
  };
}

nlohmann::json SnapshotStoreConfigToJson(const SnapshotStoreConfig& c) {
  json j{
      {"mongo_uri", c.mongo_uri},
      {"db_name", c.db_name},
      {"mongo_host", c.mongo_host},
      {"mongo_port", c.mongo_port},
      {"face_enhance_engine", c.face_enhance_engine},
      {"face_enhance_codeformer_engine", c.face_enhance_codeformer_engine},
  };
  j["mongo_readonly_username"] =
      c.mongo_readonly_username.has_value() ? json(*c.mongo_readonly_username) : json(nullptr);
  j["mongo_readonly_password"] =
      c.mongo_readonly_password.has_value() ? json(*c.mongo_readonly_password) : json(nullptr);
  return j;
}

}  // namespace ai_service::config

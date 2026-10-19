// Copyright AINVR. Adapted for the S100P service.
// 对应 Python config.py 的 pydantic 模型 + config_store.py 的合并/校验
// 逻辑。v1 下线后,Python 侧不再是校验权威——本模块自己就是权威,必须
// 完整实现 config.py 里的全部字段级/跨字段校验(extra=forbid 语义、取值
// 范围、adapter+provider 互斥组合等),不能假设上游已经校验过。
//
// OsdConfig 的画框字段、SeiConfig.match_window_ms 是 Python 里明确标注
// 的死配置(osd_encode 模式已下线,字段只为兼容旧 config_overlay.json 反
// 序列化)。这里仍然要接受这些字段出现在 JSON 里(不能因为多了未识别字段
// 就报 extra=forbid 错误导致老配置加载失败),但不解析出有意义的值、不
// 接任何逻辑——用一个通用的"已知但忽略"字段名单实现,不需要真的定义
// OsdConfig 结构体。
#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include "../pipeline/preprocess_config.hpp"  // 复用 pipeline::PreprocessConfig
#include "../analytics/config.hpp"

namespace ai_service::config {

// 配置校验失败(字段类型错、取值超范围、未知字段、跨字段规则不满足)。
// 对应 Python 的 ConfigValidationError——patch 深合并后整体校验不过。
class ConfigValidationError : public std::runtime_error {
 public:
  explicit ConfigValidationError(const std::string& msg) : std::runtime_error(msg) {}
};

struct ReconnectConfig {
  bool enabled = true;
  double initial_delay = 1.0;
  double max_delay = 10.0;
  double backoff_factor = 2.0;
};

struct StreamConfig {
  std::string url;  // 必填,无默认值;必须 rtmp:// / http:// / https:// 开头
  std::string protocol = "auto";  // rtmp / flv / auto
  double watchdog_timeout_seconds = 5.0;
  ReconnectConfig reconnect;
  // 仅供排障:强制源编码("h264"/"h265"),不上 UI。正常由 SRS 报告的
  // video.codec 自动识别(设计 D7);SRS API 不可用时才需要它。
  std::optional<std::string> codec_override;
};

struct PromptLabel {
  std::string description, label_id, label_name;
};

struct ModelConfig {
  std::string name = "yolo26m";
  // yolo26_end2end / yolo26_traditional / yolo26_bpu / yoloface_bpu / scrfd_bpu
  std::string adapter = "yolo26_bpu";
  std::string path = "models/yolo26m.hbm";
  std::vector<int> input_size = {640, 640};  // [h, w],必须为 stride 整数倍
  int stride = 32;
  std::string provider = "bpu";  // bpu (.hbm) / cpu (.onnx)
  std::string engine_cache = "data/model_cache/";
  std::optional<std::vector<std::string>> class_names;  // nullopt = 内置 COCO 80 类
  std::string description;
  std::string label_id;
  std::string label_name;
  std::vector<PromptLabel> prompts;  // Stable per-category identity, independent of slot order.
  int max_new_tokens = 64;
};

struct PostprocessConfig {
  double conf_threshold = 0.25;  // [0,1]
  double iou_threshold = 0.45;   // [0,1]
  int max_detections = 300;
};

struct ResultBufferConfig {
  int max_frames = 30;
};

struct SeiConfig {
  int max_payload_bytes = 1024;  // [256,4096]
  // match_window_ms 死字段,不建模,见文件头注释。
};

struct PublishConfig {
  bool enabled = false;
  std::string mode = "passthrough_sei";  // 唯一合法值;历史值 osd_encode 静默改写成这个
  std::string rtmp_base = "rtmp://127.0.0.1:1935";
  std::optional<std::string> target_url;
  double watchdog_timeout_seconds = 5.0;
  std::string srs_api_base = "http://127.0.0.1:1985";
  // H.265 源的 AI 输出 FLV 写法:codec12(默认,项目标准)/ enhanced。H.264 不受影响。
  std::string flv_format = "codec12";
  ReconnectConfig reconnect;
  SeiConfig sei;
  // osd 死配置,不建模,见文件头注释——解析时识别这个 key 但丢弃内容。
};

struct SnapshotConfig {
  bool enabled = false;
  int max_count = 10000;             // > 0
  int min_interval_ms = 0;           // 0: archive every inferred frame with backpressure
  int jpeg_quality = 82;             // [1,100]
  int max_crop_dimension = 320;      // > 0
  double padding_ratio = 0.25;       // [0,1]
  std::string projection_mode = "none";  // none / erp_equirect
  bool brightness_enabled = false;
  int brightness_target = 128;       // [0,255]
  std::string face_enhance_model = "none";  // none / gpen / codeformer
  double face_enhance_blend = 0.5;   // [0,1]
  // face_enhance_enabled(bool,已废弃)不建模为字段——解析时识别、迁移成
  // face_enhance_model,不保留在结构体里(对应 Python 的 exclude=True)。
};

struct ChannelConfig {
  std::string id;  // 必填,无默认值
  std::string name;
  bool enabled = true;
  bool deletion_pending = false;  // persisted deletion intent; never restart acquisition
  bool manually_stopped = false;  // persisted operator stop; survives service restarts
  StreamConfig stream;  // 必填(内部 url 必填)
  double inference_fps = 5.0;  // 0 = 跟源流帧率
  int max_consecutive_failures = 10;
  ModelConfig model;
  pipeline::PreprocessConfig preprocess;
  PostprocessConfig postprocess;
  ResultBufferConfig result_buffer;
  PublishConfig publish;
  SnapshotConfig snapshot;
  analytics::Config analytics;
};

struct ServerConfig {
  std::string host = "0.0.0.0";
  int port = 8000;
  std::string log_level = "info";  // debug/info/warning/error
  std::optional<std::string> api_key;
};

struct SnapshotStoreConfig {
  std::string mongo_uri = "mongodb://127.0.0.1:27017";
  std::string db_name = "ai_snapshots";
  std::optional<std::string> mongo_readonly_username;
  std::optional<std::string> mongo_readonly_password;
  std::string mongo_host = "127.0.0.1";
  int mongo_port = 27017;
  std::string face_enhance_engine = "models/gpen_bfr_256.hbm";
  std::string face_enhance_codeformer_engine = "models/codeformer.hbm";
};

struct AppConfig {
  ServerConfig server;
  SnapshotStoreConfig snapshot_store;
  std::vector<ChannelConfig> channels;
};

// ---- JSON <-> AppConfig ----
//
// 统一以 nlohmann::json 作为 YAML 基座 / JSON overlay 的公共中间表示：
// YAML 文件加载后先转换成等价 json 对象,overlay 文件本身就是 json,两者
// 用同一套 DeepMerge (config_store.hpp) 合并后,再喂给这里的解析+校验
// 函数,解析函数只写一份,不用为 YAML::Node 和 json 各写一套。

// 把 AppConfig 反序列化 + 全量校验(等价 pydantic 的 field_validator +
// model_validator)。不满足任一规则抛 ConfigValidationError。
AppConfig AppConfigFromJson(const nlohmann::json& root);

// 单个 ChannelConfig 的反序列化 + 校验,复用于 create_channel 等只传入
// 一个 channel patch 的场景(config_store.cpp / control_server.cpp 会用到)。
ChannelConfig ChannelConfigFromJson(const nlohmann::json& node);

// ---- AppConfig/ChannelConfig -> JSON(序列化方向,供 control_server 的
// GET 系列响应体用,等价 pydantic 的 model_dump()) ----
//
// include_id=false 时不输出 "id" 字段(对应 Python
// worker.cfg.model_dump(exclude={"id"}) ——通道视图的 config 字段单独在
// 外层放 id,内层 config 对象不重复)。
nlohmann::json ChannelConfigToJson(const ChannelConfig& cfg, bool include_id = true);
nlohmann::json ServerConfigToJson(const ServerConfig& cfg);
nlohmann::json SnapshotStoreConfigToJson(const SnapshotStoreConfig& cfg);

// 便利函数:直接从单个 YAML 文件加载(不做 overlay 合并)。文件不存在/
// YAML 语法错误/必填字段缺失/校验不通过都抛异常。config_store.hpp 的
// ConfigStore 是生产环境实际使用的入口(YAML 底 + JSON overlay 合并),
// 这个函数主要给测试/一次性场景用。
AppConfig LoadAppConfig(const std::string& path);

}  // namespace ai_service::config

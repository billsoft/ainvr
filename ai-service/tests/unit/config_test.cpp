// Copyright AINVR. Adapted for the S100P service.
// config.cpp 既做反序列化也做全量业务校验(v1 下线后 Python 侧不再是
// 校验权威,详见移植设计文档 docs/v1_parity_design.md §3.3)。测试目标:
// 字段读对了、默认值和 Python 版 config.py 一致、必填字段缺失/校验规则
// 不满足时都要报错——逐条对应 config.py 的 field_validator/model_validator。
#include <gtest/gtest.h>

#include <unistd.h>

#include <cstdio>

#include <fstream>

#include <nlohmann/json.hpp>

#include "../../src/config/config.hpp"

using namespace ai_service::config;
using nlohmann::json;

TEST(Config, YoloeDynamicPromptSupportsCustomDescriptionAndLabels) {
  json source = {{"id", "dynamic"}, {"stream", {{"url", "rtmp://localhost/live/cam"}}},
    {"model", {{"adapter", "yoloe_bpu"}, {"path", "models/yoloe-26x-seg.hbm"},
    {"provider", "bpu"}, {"input_size", {640, 640}}, {"description", "backpack"},
    {"label_id", "bag"}, {"label_name", "行囊"}}}};
  auto cfg = ChannelConfigFromJson(source);
  EXPECT_EQ(cfg.model.description, "backpack");
  EXPECT_EQ(ChannelConfigFromJson(ChannelConfigToJson(cfg)).model.label_name, "行囊");
  source["model"]["description"] = "red car";
  EXPECT_EQ(ChannelConfigFromJson(source).model.description, "red car");
  source["model"]["description"] = "";
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
  source["model"]["description"] = "car";
  for (const auto& invalid : {std::string("   "), std::string("bus\tstop"), std::string("bus\0stop", 8)}) {
    source["model"]["description"] = invalid;
    EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
  }
  source["model"]["description"] = "car";
  source["postprocess"] = {{"max_detections", 301}};
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
  source["postprocess"]["max_detections"] = 300;
  EXPECT_NO_THROW(ChannelConfigFromJson(source));
  source["model"]["provider"] = "cpu";
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
}

TEST(Config, OpenVocabularyHasExplicitQueryAndFractionalSchedule) {
  json source = {{"id", "open"}, {"stream", {{"url", "rtmp://localhost/live/cam"}}},
    {"inference_fps", 1.0 / 15.0}, {"model", {{"adapter", "locateanything_bpu"},
    {"input_size", {448, 448}}, {"description", "adult woman"},
    {"label_id", "woman"}, {"label_name", "成年女性"}}}};
  auto cfg = ChannelConfigFromJson(source);
  EXPECT_DOUBLE_EQ(cfg.inference_fps, 1.0 / 15.0);
  EXPECT_EQ(cfg.model.description, "adult woman");
  auto roundtrip = ChannelConfigFromJson(ChannelConfigToJson(cfg));
  EXPECT_EQ(roundtrip.model.label_id, "woman");
  source["inference_fps"] = 0;
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
  source["inference_fps"] = 0.1;
  source["model"]["description"] = "<|im_end|>";
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
  source["model"]["description"] = "adult woman";
  source["model"].erase("label_name");
  EXPECT_THROW(ChannelConfigFromJson(source), ConfigValidationError);
}

TEST(Config, ParsesRealExampleFile) {
  AppConfig cfg = LoadAppConfig(CONFIG_EXAMPLE_PATH);

  EXPECT_EQ(cfg.server.host, "0.0.0.0");
  EXPECT_EQ(cfg.server.port, 8000);
  EXPECT_EQ(cfg.server.log_level, "info");
  EXPECT_FALSE(cfg.server.api_key.has_value());

  ASSERT_EQ(cfg.channels.size(), 1u);
  const auto& ch = cfg.channels[0];
  EXPECT_EQ(ch.id, "cam01");
  EXPECT_EQ(ch.name, "测试摄像头");
  EXPECT_TRUE(ch.enabled);

  EXPECT_EQ(ch.stream.url, "rtmp://127.0.0.1:1935/live/phase6_test");
  EXPECT_EQ(ch.stream.protocol, "auto");
  EXPECT_DOUBLE_EQ(ch.stream.watchdog_timeout_seconds, 5.0);
  EXPECT_TRUE(ch.stream.reconnect.enabled);
  EXPECT_DOUBLE_EQ(ch.stream.reconnect.initial_delay, 1.0);
  EXPECT_DOUBLE_EQ(ch.stream.reconnect.max_delay, 60.0);
  EXPECT_DOUBLE_EQ(ch.stream.reconnect.backoff_factor, 2.0);

  EXPECT_DOUBLE_EQ(ch.inference_fps, 5.0);
  EXPECT_EQ(ch.max_consecutive_failures, 10);

  EXPECT_EQ(ch.model.name, "yolo26m");
  EXPECT_EQ(ch.model.adapter, "yolo26_bpu");
  EXPECT_EQ(ch.model.path, "models/yolo26m.hbm");
  EXPECT_EQ(ch.model.input_size, (std::vector<int>{640, 640}));
  EXPECT_EQ(ch.model.stride, 32);
  EXPECT_EQ(ch.model.provider, "bpu");
  EXPECT_EQ(ch.model.engine_cache, "data/model_cache/");
  EXPECT_FALSE(ch.model.class_names.has_value());

  EXPECT_TRUE(ch.preprocess.letterbox);
  EXPECT_EQ(ch.preprocess.padding_color, (std::array<int, 3>{114, 114, 114}));
  EXPECT_EQ(ch.preprocess.interpolation, "bilinear");
  EXPECT_TRUE(ch.preprocess.normalize);
  EXPECT_EQ(ch.preprocess.mean, (std::array<double, 3>{0.0, 0.0, 0.0}));
  EXPECT_EQ(ch.preprocess.std, (std::array<double, 3>{255.0, 255.0, 255.0}));
  EXPECT_TRUE(ch.preprocess.rgb_order);

  EXPECT_DOUBLE_EQ(ch.postprocess.conf_threshold, 0.25);
  EXPECT_DOUBLE_EQ(ch.postprocess.iou_threshold, 0.45);
  EXPECT_EQ(ch.postprocess.max_detections, 300);

  EXPECT_EQ(ch.result_buffer.max_frames, 30);

  // config.example.yaml 没写 publish/snapshot 段,必须落回 Python 端一致的默认值
  EXPECT_FALSE(ch.publish.enabled);
  EXPECT_EQ(ch.publish.mode, "passthrough_sei");
  EXPECT_EQ(ch.publish.rtmp_base, "rtmp://127.0.0.1:1935");
  EXPECT_EQ(ch.publish.srs_api_base, "http://127.0.0.1:1985");
  EXPECT_EQ(ch.publish.sei.max_payload_bytes, 1024);

  EXPECT_FALSE(ch.snapshot.enabled);
  EXPECT_EQ(ch.snapshot.max_count, 10000);
  EXPECT_EQ(ch.snapshot.projection_mode, "none");
  EXPECT_EQ(ch.snapshot.face_enhance_model, "none");
}

namespace {
// 临时 YAML:文件名带 pid 避免并行测试互相覆盖,析构即删除。
struct TempYaml {
  std::string path;
  explicit TempYaml(const std::string& name)
      : path(std::string(::testing::TempDir()) + name + "_" + std::to_string(::getpid()) +
             ".yaml") {}
  ~TempYaml() { std::remove(path.c_str()); }
};
}  // namespace

TEST(Config, MissingChannelIdThrows) {
  TempYaml tmp("bad_channel");
  const std::string& tmp_path = tmp.path;
  {
    std::ofstream f(tmp_path);
    f << "channels:\n  - name: no-id-here\n    stream:\n      url: rtmp://x\n";
  }
  EXPECT_THROW(LoadAppConfig(tmp_path), std::runtime_error);
}

TEST(Config, MissingStreamUrlThrows) {
  TempYaml tmp("bad_stream");
  const std::string& tmp_path = tmp.path;
  {
    std::ofstream f(tmp_path);
    f << "channels:\n  - id: cam01\n    stream:\n      protocol: auto\n";
  }
  EXPECT_THROW(LoadAppConfig(tmp_path), std::runtime_error);
}

TEST(Config, ServerDefaultsWhenSectionAbsent) {
  TempYaml tmp("empty");
  const std::string& tmp_path = tmp.path;
  {
    std::ofstream f(tmp_path);
    f << "channels: []\n";
  }
  AppConfig cfg = LoadAppConfig(tmp_path);
  EXPECT_EQ(cfg.server.host, "0.0.0.0");
  EXPECT_EQ(cfg.server.port, 8000);
  EXPECT_TRUE(cfg.channels.empty());
}

// ---- 以下为 advisor 复核后新增:全量业务校验规则,逐条对应 config.py ----

namespace {
json MinimalChannel() {
  return json{{"id", "cam01"}, {"stream", {{"url", "rtmp://127.0.0.1/live/x"}}}};
}
}  // namespace

TEST(ConfigValidation, MinimalChannelParsesOk) {
  EXPECT_NO_THROW(ChannelConfigFromJson(MinimalChannel()));
}

// inference_fps 过小时推理线程按节拍睡眠 1/fps 秒,且这段睡眠不可被停止打断:
// 配成 0.0001 停一个通道要等近 3 小时。0 = 跟随源流,负数无意义。
TEST(ConfigValidation, InferenceFpsLowerBound) {
  json ch = MinimalChannel();
  ch["inference_fps"] = 0;
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
  ch["inference_fps"] = 0.1;
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
  for (double bad : {0.0001, 0.05, -1.0}) {
    ch["inference_fps"] = bad;
    EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError) << bad;
  }
}

TEST(ConfigValidation, StreamUrlMustHaveValidScheme) {
  json ch = MinimalChannel();
  ch["stream"]["url"] = "ftp://x";
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, UnknownTopLevelChannelFieldRejected) {
  json ch = MinimalChannel();
  ch["totally_unknown_field"] = 1;
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, UnknownStreamFieldRejected) {
  json ch = MinimalChannel();
  ch["stream"]["bogus"] = 1;
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, ModelInputSizeMustBeStrideMultiple) {
  json ch = MinimalChannel();
  ch["model"] = {{"input_size", json::array({641, 640})}, {"stride", 32}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, ModelInputSizeMustBeTwoElements) {
  json ch = MinimalChannel();
  ch["model"] = {{"input_size", json::array({640})}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, OnnxAdapterRejectsNonCpuProvider) {
  json ch = MinimalChannel();
  ch["model"] = {{"adapter", "yolo26_end2end"}, {"provider", "bpu"}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, OnnxAdapterAcceptsCpuProvider) {
  json ch = MinimalChannel();
  ch["model"] = {{"adapter", "yolo26_end2end"}, {"provider", "cpu"}, {"path", "models/yolo26m.onnx"}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, BpuAdapterAcceptsBpuProvider) {
  json ch = MinimalChannel();
  ch["model"] = {{"adapter", "yolo26_bpu"}, {"provider", "bpu"}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, UnknownAdapterRejected) {
  json ch = MinimalChannel();
  ch["model"] = {{"adapter", "made_up_adapter"}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, AiSampleSizeNonZeroRejected) {
  json ch = MinimalChannel();
  ch["preprocess"] = {{"ai_sample_width", 640}, {"ai_sample_height", 0}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, AiSampleSizeZeroZeroToleratedAsDeadField) {
  json ch = MinimalChannel();
  ch["preprocess"] = {{"ai_sample_width", 0}, {"ai_sample_height", 0}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, PaddingColorOutOfRangeRejected) {
  json ch = MinimalChannel();
  ch["preprocess"] = {{"padding_color", json::array({114, 114, 300})}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, PostprocessThresholdOutOfRangeRejected) {
  json ch = MinimalChannel();
  ch["postprocess"] = {{"conf_threshold", 1.5}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, SeiMaxPayloadBytesOutOfRangeRejected) {
  json ch = MinimalChannel();
  ch["publish"] = {{"sei", {{"max_payload_bytes", 100}}}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, SeiMatchWindowMsToleratedAsDeadField) {
  json ch = MinimalChannel();
  ch["publish"] = {{"sei", {{"match_window_ms", 50}}}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, OsdSubObjectToleratedAsDeadField) {
  json ch = MinimalChannel();
  ch["publish"] = {{"osd", {{"box_color", json::array({0, 255, 0, 255})}, {"stale_ms", 800}}}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, LegacyOsdEncodeModeRewrittenToPassthroughSei) {
  json ch = MinimalChannel();
  ch["publish"] = {{"mode", "osd_encode"}};
  ChannelConfig c = ChannelConfigFromJson(ch);
  EXPECT_EQ(c.publish.mode, "passthrough_sei");
}

TEST(ConfigValidation, PublishEnabledRequiresRtmpSourceUrl) {
  json ch = json{{"id", "cam01"}, {"stream", {{"url", "http://x/y.flv"}}}};
  ch["publish"] = {{"enabled", true}, {"target_url", "rtmp://x/live/out"}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, PublishEnabledRequiresTargetUrl) {
  json ch = MinimalChannel();
  ch["publish"] = {{"enabled", true}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, PublishEnabledTargetUrlMustBeRtmp) {
  json ch = MinimalChannel();
  ch["publish"] = {{"enabled", true}, {"target_url", "http://x/y"}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, PublishEnabledWithValidRtmpPasses) {
  json ch = MinimalChannel();
  ch["publish"] = {{"enabled", true}, {"target_url", "rtmp://x/live/out"}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, SnapshotFaceEnhanceEnabledMigratesToModel) {
  json ch = MinimalChannel();
  ch["snapshot"] = {{"face_enhance_enabled", true}};
  ChannelConfig c = ChannelConfigFromJson(ch);
  EXPECT_EQ(c.snapshot.face_enhance_model, "gpen");
}

TEST(ConfigValidation, SnapshotFaceEnhanceModelTakesPriorityOverLegacyFlag) {
  json ch = MinimalChannel();
  ch["snapshot"] = {{"face_enhance_enabled", true}, {"face_enhance_model", "codeformer"}};
  ChannelConfig c = ChannelConfigFromJson(ch);
  EXPECT_EQ(c.snapshot.face_enhance_model, "codeformer");
}

TEST(ConfigValidation, SnapshotBrightnessTargetOutOfRangeRejected) {
  json ch = MinimalChannel();
  ch["snapshot"] = {{"brightness_target", 300}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, SnapshotMaxCountMustBePositive) {
  json ch = MinimalChannel();
  ch["snapshot"] = {{"max_count", 0}};
  EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
}

TEST(ConfigValidation, LegacyArchiveSamplingLoadsAsEveryInference) {
  auto ch = MinimalChannel();
  ch["snapshot"] = {{"min_interval_ms", 1000}};
  EXPECT_EQ(ChannelConfigFromJson(ch).snapshot.min_interval_ms, 0);
}

TEST(ConfigValidation, ErpCropSizeHasExplicitSupportedRange) {
  auto ch = MinimalChannel();
  ch["snapshot"] = {{"projection_mode", "erp_equirect"}, {"max_crop_dimension", 1280}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
  for (int size : {0, 1281, 2048}) {
    ch["snapshot"]["max_crop_dimension"] = size;
    EXPECT_THROW(ChannelConfigFromJson(ch), ConfigValidationError);
  }
  ch["snapshot"] = {{"projection_mode", "none"}, {"max_crop_dimension", 2048}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(ConfigValidation, DuplicateChannelIdsRejected) {
  json root;
  root["channels"] = json::array({MinimalChannel(), MinimalChannel()});
  EXPECT_THROW(AppConfigFromJson(root), ConfigValidationError);
}

TEST(ConfigValidation, RealProductionOverlayShapeParsesOk) {
  // 精简版生产 overlay 形状(§1.3 要求能原样加载 v1 现网 overlay,这里覆盖
  // 其中最有代表性的字段组合:erp_equirect + 人脸增强 + 曝光校正 + 死字段)。
  json root = R"({
    "channels": [{
      "id": "demo-detect",
      "name": "大门口_人脸识别",
      "enabled": true,
      "stream": {"url": "rtmp://127.0.0.1:1935/live/phase6_test", "protocol": "rtmp"},
      "inference_fps": 15.0,
      "model": {"adapter": "yolo26_bpu", "provider": "bpu"},
      "preprocess": {"ai_sample_width": 0, "ai_sample_height": 0},
      "publish": {
        "enabled": true,
        "target_url": "rtmp://127.0.0.1:1935/live/phase6_test_ai_out",
        "sei": {"max_payload_bytes": 1024, "match_window_ms": 0, "format": "json"},
        "osd": {"stale_ms": 800, "box_color": [0, 255, 0, 255]}
      },
      "snapshot": {
        "enabled": true,
        "projection_mode": "erp_equirect",
        "face_enhance_enabled": true,
        "brightness_enabled": true,
        "brightness_target": 220
      }
    }],
    "server": {"api_key": "test-api-key-not-real"},
    "snapshot_store": {
      "mongo_uri": "mongodb://u:p@192.168.100.183:27017/ai_snapshots?authSource=ai_snapshots",
      "db_name": "ai_snapshots",
      "mongo_readonly_username": "ai_snapshots_readonly",
      "mongo_readonly_password": "x",
      "mongo_host": "192.168.100.183",
      "mongo_port": 27017
    }
  })"_json;

  AppConfig cfg = AppConfigFromJson(root);
  ASSERT_EQ(cfg.channels.size(), 1u);
  const auto& ch = cfg.channels[0];
  EXPECT_EQ(ch.id, "demo-detect");
  EXPECT_EQ(ch.snapshot.projection_mode, "erp_equirect");
  EXPECT_EQ(ch.snapshot.face_enhance_model, "gpen");  // 迁移后不再是 face_enhance_enabled
  EXPECT_TRUE(ch.snapshot.brightness_enabled);
  EXPECT_EQ(ch.snapshot.brightness_target, 220);
  EXPECT_EQ(ch.publish.target_url, "rtmp://127.0.0.1:1935/live/phase6_test_ai_out");
  EXPECT_EQ(cfg.server.api_key, "test-api-key-not-real");
  EXPECT_EQ(cfg.snapshot_store.mongo_host, "192.168.100.183");
}

// ---- 序列化方向(ChannelConfigToJson 等),供 control_server 响应体用 ----

TEST(ConfigSerialization, ChannelConfigRoundTripPreservesFields) {
  ChannelConfig original = ChannelConfigFromJson(MinimalChannel());
  json j = ChannelConfigToJson(original);
  EXPECT_EQ(j["id"], "cam01");
  ChannelConfig reparsed = ChannelConfigFromJson(j);
  EXPECT_EQ(reparsed.id, original.id);
  EXPECT_EQ(reparsed.stream.url, original.stream.url);
  EXPECT_EQ(reparsed.model.adapter, original.model.adapter);
}

TEST(ConfigSerialization, ChannelConfigToJsonExcludeIdOmitsKey) {
  ChannelConfig c = ChannelConfigFromJson(MinimalChannel());
  json j = ChannelConfigToJson(c, /*include_id=*/false);
  EXPECT_FALSE(j.contains("id"));
}

TEST(ConfigSerialization, ChannelConfigToJsonOutputsMigratedFaceEnhanceField) {
  json ch = MinimalChannel();
  ch["snapshot"] = {{"face_enhance_enabled", true}};
  ChannelConfig c = ChannelConfigFromJson(ch);
  json j = ChannelConfigToJson(c);
  // 迁移是单向的:outbound 只能看到新字段,旧字段不能再出现。
  EXPECT_EQ(j["snapshot"]["face_enhance_model"], "gpen");
  EXPECT_FALSE(j["snapshot"].contains("face_enhance_enabled"));
}

TEST(ConfigSerialization, ServerConfigToJsonNeverLeaksApiKeyPlaintext) {
  ServerConfig s;
  s.api_key = "super-secret";
  json j = ServerConfigToJson(s);
  EXPECT_TRUE(j["api_key_set"]);
  EXPECT_FALSE(j.contains("api_key"));  // 只告诉调用方"设没设",不告诉值
}

// ---- 归一化参数:没显式写就用模型族默认值,写了就尊重配置 ----

TEST(PreprocessResolve, ExplicitFlagFollowsJsonKeys) {
  json ch = MinimalChannel();
  EXPECT_FALSE(ChannelConfigFromJson(ch).preprocess.normalization_explicit);
  ch["preprocess"] = {{"letterbox", true}};
  EXPECT_FALSE(ChannelConfigFromJson(ch).preprocess.normalization_explicit);
  ch["preprocess"] = {{"mean", {0, 0, 0}}, {"std", {255, 255, 255}}};
  EXPECT_TRUE(ChannelConfigFromJson(ch).preprocess.normalization_explicit);
}

TEST(PreprocessResolve, LegacyGpuDirectKeyStillAccepted) {
  // 生产 overlay 里有 gpu_direct:true;所有模型都已改走 GPU 直写,键仍须能加载
  json ch = MinimalChannel();
  ch["preprocess"] = {{"gpu_direct", true}};
  EXPECT_NO_THROW(ChannelConfigFromJson(ch));
}

TEST(PreprocessResolve, ModelDefaultsUnlessExplicit) {
  ai_service::pipeline::PreprocessConfig model_default;
  model_default.mean = {127.5, 127.5, 127.5};
  model_default.std = {128, 128, 128};
  ai_service::pipeline::PreprocessConfig cfg;  // 未显式:0/255
  cfg.padding_color = {1, 2, 3};
  auto r = ai_service::pipeline::ResolvePreprocess(cfg, model_default);
  EXPECT_DOUBLE_EQ(r.mean[0], 127.5);
  EXPECT_EQ(r.padding_color[2], 3);  // 缩放/灰边仍取配置
  cfg.normalization_explicit = true;
  r = ai_service::pipeline::ResolvePreprocess(cfg, model_default);
  EXPECT_DOUBLE_EQ(r.mean[0], 0.0);
}

// ---- H.265(设计 docs/h265-codec12-support-design-2026-09-29.md §6.1/§6.6)----

TEST(ConfigH265, PublishFlvFormatDefaultsToCodec12AndValidates) {
  json ch = MinimalChannel();
  auto c = ChannelConfigFromJson(ch);
  EXPECT_EQ(c.publish.flv_format, "codec12");  // 项目标准:AI 输出默认 codec12
  ch["publish"] = {{"flv_format", "enhanced"}};
  EXPECT_EQ(ChannelConfigFromJson(ch).publish.flv_format, "enhanced");
  ch["publish"] = {{"flv_format", "hvc1"}};
  EXPECT_THROW(ChannelConfigFromJson(ch), std::exception);
}

TEST(ConfigH265, StreamCodecOverrideIsOptionalAndValidated) {
  json ch = MinimalChannel();
  EXPECT_FALSE(ChannelConfigFromJson(ch).stream.codec_override.has_value());  // 默认自动识别
  ch["stream"]["codec_override"] = "h265";
  EXPECT_EQ(ChannelConfigFromJson(ch).stream.codec_override, "h265");
  ch["stream"]["codec_override"] = "vp9";
  EXPECT_THROW(ChannelConfigFromJson(ch), std::exception);
}

TEST(ConfigH265, NewFieldsRoundTripThroughJson) {
  json ch = MinimalChannel();
  ch["stream"]["codec_override"] = "h264";
  ch["publish"] = {{"flv_format", "enhanced"}};
  auto c = ChannelConfigFromJson(ch);
  auto back = ChannelConfigFromJson(ChannelConfigToJson(c, true));
  EXPECT_EQ(back.stream.codec_override, "h264");
  EXPECT_EQ(back.publish.flv_format, "enhanced");
  // 未设置调试覆盖时不输出该键(不让 GET→PUT 把 null 写回配置)
  EXPECT_FALSE(ChannelConfigToJson(ChannelConfigFromJson(MinimalChannel()), true)["stream"].contains("codec_override"));
}

TEST(ConfigValidation, OperatorStopRoundTripsOnlyWhenSet) {
  auto ch = MinimalChannel();
  EXPECT_FALSE(ChannelConfigFromJson(ch).manually_stopped);
  EXPECT_FALSE(ChannelConfigToJson(ChannelConfigFromJson(ch), true).contains("manually_stopped"));
  ch["manually_stopped"] = true;
  auto parsed = ChannelConfigFromJson(ch);
  EXPECT_TRUE(parsed.manually_stopped);
  EXPECT_TRUE(ChannelConfigToJson(parsed, true)["manually_stopped"].get<bool>());
}

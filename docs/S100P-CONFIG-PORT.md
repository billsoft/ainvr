# AINVR S100P 配置与配置中心迁移

配置解析、YAML/JSON 合并、原子持久化、配置中心轮询/应用/状态回报已移入 AINVR 构建。参考子模块只读，移植前核对全部参考源文件哈希。

## 平台契约

默认 `model.adapter=yolo26_bpu`、`model.provider=bpu`、`model.path=models/yolo26m.hbm`。支持声明 `yoloface_bpu`、`scrfd_bpu`、`yoloe_bpu` 和 `locateanything_bpu` 的配置；这只是配置契约，不表示各模型运行适配器已实现或模型已经编译成功。

BPU 适配器只接受 bpu provider 和 `.hbm` 路径。`yolo26_end2end` / `yolo26_traditional` 的 CPU 契约只接受 cpu 与 `.onnx`。启动阶段仍须核对模型实际格式、S100P 目标、输入/输出布局和编译版本，不能仅凭扩展名判定兼容。

旧 `_trt`、`yoloe_pt`、CUDA/TensorRT provider 会明确拒绝，不把路径改名当作转换。已有控制台模型列表还需要随真实模型适配器一起迁移到这些名称；当前尚未启动 AI 服务，因此没有改写用户正在使用的配置。

截图 `projection_mode` 的 `none` / `erp_equirect` 开关、归档字段、识别阈值和热更新相关配置结构保留。配置中心继续禁止通过系统配置入口直接改 channels；通道由独立通道 API 管理。YAML 基座只读，JSON overlay 按原有加锁、权限和原子写入规则保存，失败不得覆盖有效配置。

## 验证与复用

- `ai-service/tests/unit/config_test.cpp`：字段校验及往返序列化。
- `config_store_test.cpp`：配置合并、非法配置不落盘、原子文件与权限。
- `config_center_test.cpp`：真实本机 HTTP 测试服务验证轮询、应用、失败回报、版本跟踪。
- `s100p_config_test.cpp`：BPU/ONNX 契约和旧 Jetson 配置拒绝。
- 运行记录：`test/results/config-port-20261011/`。

离线校验：`out/build/ai-s100p/ainvr_config_check CONFIG.yaml [OVERLAY.json]`。只输出通道 ID、启用状态、adapter/provider，不打印 API 密钥、Mongo URI 或流地址。`models_loaded=false` 明确表示没有加载模型。

构建及验证：`bash deploy-package/build-ai-s100p.sh`。不会替换运行中的二进制或启动 AI 服务。新板依赖已补入 `bootstrap-s100p.sh`，SDK/BSP 仍须使用匹配 S100P 的官方系统，不能用普通 apt 包代替。

## 尚未完成

完整 channel worker、控制 API 与平台接口的连接，模型专用后处理，截图/曝光/修复/归档管线，以及与控制台的真实端到端联调仍需实现。配置单测通过不能代替这些验收。

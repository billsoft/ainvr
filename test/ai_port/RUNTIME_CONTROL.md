# AINVR S100P 配置同步与运行诊断

开发目录：`/home/sunrise/ainvr`。TecheAI 为只读参考。

## 复用范围

AI 服务启动入口接入已有 `config_center_client`、`config_center_apply`、
`ConfigStore`。MongoDB 连接由原校验逻辑执行真实 ping；候选配置校验失败不落盘。
配置中心只管理系统与归档设置，通道仍由原 `ControlServer` 接口管理。

`crash_handler.cpp/.hpp`、`systemd_watchdog.hpp` 从参考项目复制，保留原行为，
仅调整 AINVR 署名与测试包含路径。启动入口安装崩溃诊断，并以有超时的 `/livez`
探测驱动看门狗。服务停止时及时唤醒并停止看门狗。系统单元启用 30 秒超时。

硬件调用、BPU 模型校验、VPU 解码和 GLES/JPU 图像处理均沿用当前适配层。
这次配置同步接入不引入 CPU 推理或 CPU 图像处理后备。

## 验证脚本

- `run_runtime_control_validation.py`：真实 AI 服务二进制 + 隔离配置中心，
  运行 20 个单元测试与 7 个配置场景。MongoDB 是真实连接验证，不写用户归档。
  覆盖回报失败重试、基于启动配置判断重启需求、拒绝通道与部署地址变更、
  API 凭据热更新、无效 MongoDB 不落盘、错误文本不泄露凭据及看门狗通知。
- `initialize_runtime_config_center.mjs --inspect`：只读检查 AI 文档与服务版本状态。
  不带参数时仅允许尚无 AI 文档的设备初始化；复用后端 `PgConfigStore`、
  `PublishOrchestrator`、`PullModeAdapter` 和敏感字段清洗，事务内写加密引用、
  生成正式版本并等待服务自行回报。已有文档或冲突凭据会拒绝覆盖。
- `deploy_runtime_control.py`：本次已检查设备的专用、带哈希检查的版本切换。
  它不是通用新板安装器。先备份私有环境与二进制，再安装已测试构建。
  保留 `/etc/systemd/system/ainvr-ai.service` 指向项目单元的链接。
- `run_reused_worker_service_validation.py`：隔离验证原控制器接入真实工作线程，
  验证输出保存、回环拒绝、缺少 HBM 时明确报错和手动停止状态保留。
  使用单独的私有环境文件，剔除配置中心凭据和看门狗参数，并断言配置中心关闭，
  避免测试进程向正式服务状态上报。

隔离测试的私有配置与环境包含本机连接凭据，应只保留在板端；报告只记录结果。
初始化脚本不设置或更改控制台管理密码。

## 2026-10-12 线上验收

运行版本：`ainvr-s100p-reused-control-0.4`。
已通过的隔离构建 SHA-256：
`417244fcef8e57089e04071d8128f63444c641437a2450929e0bc6f5878f1b4c`。

正式配置中心版本 3：AI 自行回报 `applied`，无需重启。
录像服务仍为已应用版本 2；其他服务状态未被此次发布改变。
MongoDB 与 API 凭据在 PG 文档中保存加密引用。
AI 专用服务凭据访问自己的快照返回 200，访问录像快照返回 403。
原通道、模型、手动停止状态及 MongoDB 连接配置保留。
`live/xm` 仍在 SRS 发布，服务持续运行并发送看门狗心跳。

报告：

- `test/results/runtime-control-20261012-025239/summary.json`
- `test/results/runtime-config-center-live-20261012.json`
- `test/results/runtime-control-live-verification-20261012.json`
- `test/results/reused-worker-service-20261012-030639/summary.json`
- `test/results/runtime-deployment-validation-20261012.log`

回退材料在 SSD：
`/mnt/ainvr-ssd/migration-backups/runtime-control-20261012-030341`。
包含切换前二进制、两份私有环境文件和原系统单元；不要公开或导出这些环境文件。

## 后续安装与升级入口

`deploy-package/prepare-s100p.py` 在新板准备时生成 AI 专用配置凭据，写入后端和
AI 环境文件。凭据已存在时复用，发现相互冲突则拒绝覆盖。重复执行保留现有文件。
`deploy-package/install-ai-s100p.py` 默认构建产物已改为
`out/build/ai-s100p/ainvr_s100p_control_service`；公共安装目的文件名仍是
`deploy/s100p/bin/ainvr_ai_service`，与系统单元一致。
安装器拒绝缺库、CPU ONNX 与 Jetson 推理库，启动验收要求复用控制服务版本与
仅 BPU 的模型提供器。安装备份存放在 SSD；没有挂载 SSD 时拒绝安装。

`test_runtime_deployment.py` 的 11 项测试验证真实临时目录里的首次配置准备、
重复准备、凭据一致性与冲突、保留原配置，以及旧服务和不允许的库被拒绝。
此外，已用当前二进制的真实依赖和实际 `/health` 验证安装检查能够接受线上服务。
这些测试尚不能替代一块全新开发板的完整安装验收。

## 尚未证明的完整产品目标

本轮证明配置与服务运行链路，不等于用户模型推理或浏览器验收完成。
当前用户模型目录尚无 HBM，官方样例不能替代用户模型精度与性能验收。
用户模型编译、实际播放器 SEI 叠加、浏览器操作、新板安装以及未完成的
协议与故障场景仍需继续验证。

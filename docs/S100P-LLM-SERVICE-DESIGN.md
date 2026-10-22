# AINVR 大模型微服务（llm-service）设计 v1.0

> 日期：2026-10-22 · 状态：设计定稿，待开发；未部署、未提交
> 相关：模型编译与验证 `test/model_conversion/qwen3vl/S100P-QWEN3VL-ALARM-REVIEW-BPU.md`；新手手册 `test/model_conversion/qwen3vl/S100P-QWEN3VL-BUILD-GUIDE.md`；实测数据 `test/results/llm-service-p0/`

---

## 0. 目标与范围

| 项 | 约定 |
|---|---|
| 做什么 | 在 S100P 上新增独立微服务 `llm-service`：加载 **Qwen3-VL-4B（我们自编译的 v3 O2 HBM）**，提供“告警图片 + 告警信息 → 属实分数”的复审能力，供告警服务等本机微服务调用 |
| 用哪个模型 | **只用 Qwen3-VL-4B 这一个模型**。不接入任何其他大模型 |
| 怎么实现 | 自研 C++ 推理引擎（现成框架都不能加载我们分组编译的 HBM），复用 ai-service 已验证的 JPU / Mali / BPU / 配置中心代码 |
| 本期能力 | 告警复审（首 token“是/否”打分）。**不做自由对话** |
| 对外 | 只监听 `127.0.0.1:8300`；任务接口 + OpenAI 兼容接口；控制台经后端代理访问 |
| 控制台 | 系统配置新增“大模型微服务配置”；仪表盘新增服务行、状态卡、日志来源 |

---

## 1. 模型现状（已完成，作为开发输入）

| 项 | 数据 |
|---|---|
| 模型包 | 视觉 4 包（`vis-0-6/6-12/12-18/18-24`）+ 文字 4 组（`txt-0-8/9-17/18-26/27-35`，每组含 s256、s1 两档）+ 决策头（22 个决策 token）；板上 `/mnt/ainvr-ssd/qwen3vl/*-o2-v3/` |
| 输入 | 图片 896×448（392 个视觉 token）+ 告警类型/描述；上下文容量 1024 token |
| 精度（独立集 559 项，408 项有标注） | 与原版 BF16 判定一致率 97.67%（0.5 阈值）；标注准确率 88.2%；误报拦截 97.4%、真报保留 80.4%；区分能力 AUC 0.978 |
| 速度 | 单次复审中位 2.83 s；纯 BPU 2.54 s（视觉 124–128 ms×4，文字 s256 235–237 ms×8，s1 37 ms×4，决策头 0.5 ms） |
| 资源 | ION 5.5 GB；BPU 1 核；ION 池共 7.5 GiB（与 ai-service、LocateAnything 共用） |
| 提示词 | 固定模板 `alarm-review-zh-v1`（精度只对它验证过） |

---

## 2. 架构

```
告警服务等本机服务 ──HTTP 127.0.0.1:8300──┐                 浏览器
                                           │        Nginx /api/llm/（关缓冲）
                                           │                 │
                                           │        控制台后端 /api/llm/*（会话鉴权，密钥不下发浏览器）
                                           ▼                 ▼
┌──────────────── ainvr_llm_service（C++17 单进程，systemd: ainvr-llm.service）────────────────┐
│ 协议层  /health /v1/status /v1/models /v1/ainvr/tasks/alarm-review-zh-v1                     │
│         /v1/chat/completions /v1/admin/{load,unload}；推理密钥/管理密钥；OpenAI 错误格式      │
│ 调度层  有界队列 → 单 BPU 工作线程；提交时间配额；只在 BPU 调用间隙取消                        │
│ 资源层  BPU 内存预留（共同锁 + 静态预算 + 加载后余量验证）；模型包清单与 sha256 校验          │
│ 引擎    分词 → 任务模板 → 图片前处理 → 视觉 4 包 → 词向量 → 文字 4 组 prefill → 决策头 → 打分  │
│ 硬件    JPU 解码 → Mali NV12→RGB → Mali 双三次缩放 → Mali 归一化与切块 → BPU                   │
│ 配置    配置中心拉取模式（同告警服务），热应用，失败只回滚本服务                              │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ libdnn / libhbucp / libmultimedia / Mali EGL+GLES          ▲ 采集助手探 /health
        ▼                                                             │
     BPU（1 核）+ ION 7.5 GiB
```
代码里保留一个“模型适配器”接口，便于以后换模型时不改外壳；本期只有 Qwen3-VL 一个实现。

---

## 3. 引擎模块

精确的输入输出与算法规则见**附录 A**。

| 模块 | 职责 | 复用 / 新写 |
|---|---|---|
| `bpu_program` | 一个 HBM 打开一次，按名字取 `s256`/`s1` 等档位；输入输出张量用 `hbUCPMallocCached` 常驻；同形状输入可指向同一块内存；只 flush 改动范围；等待超时即隔离缓冲与任务并置故障 | 参照 `ai-service/src/platform/bpu.cpp` 新写 |
| `package` | 读 `llm-package.ainvr.json`，逐文件 sha256；mmap 词向量表（BF16，0.78 GB）、MRoPE / 视觉旋转 / 归一化表 | 新写 |
| `tokenizer` | `tokenizers-cpp` 读 Qwen 自带 `tokenizer.json`（与 HF 结果一致） | 第三方库（固定 commit `c586c52`） |
| `task_template` | 拼 `alarm-review-zh-v1` 模板，按真实 token 数检查长度 | 新写 |
| `image_pipeline` | JPEG → JPU → NV12 → Mali RGB → Mali Pillow 9.3 双三次到 896×448 → Mali 查表归一化 + 切块排布到 [1568,1536]，直接写入视觉第 1 包输入缓冲 | 复用 `vpu_decoder`、`gles_preprocess`；参照 `locateanything_pillow_preprocess.hpp` 新写 896×448 着色器 |
| `vision_runner` | 4 个视觉包串行，收集 3 份 DeepStack 特征与合并特征 | 新写 |
| `qwen3vl_layout` | 位置编码、掩码、KV 排布、prefill 计划 | 移植 `qwen3vl_host_v1.py` |
| `text_prefill` | 4 组 × （s256、s256、s1）；一套 KV 缓冲在 4 组、两档间复用 | 新写 |
| `decision_head` / `scoring` | 22 个决策 logit → 属实分数 | 新写 |

时序（单 BPU 线程）：分词与模板（CPU，<5 ms）→ 图片前处理（独立线程，可与上一请求的 BPU 段并行）→ 视觉（BPU ≈505 ms）→ 词向量（CPU）→ 文字 prefill（BPU ≈2040 ms）→ 决策头 → 打分 → 响应。

数值一致性：所有浮点表离线用 numpy 生成进包，C++ 只查表；同一输入张量下 C++ 的 22 个 logit 与 `board_run_alarm_v1.py` 逐位相同。

---

## 4. 模型包

目录 `ai-service/models/llm/qwen3vl-4b-review-v3/`，由 `llm-service/tools/build_package.py` 从 `/mnt/ainvr-ssd/qwen3vl/*-o2-v3`、`run-v1/embed_tokens_bf16bits.npy`、`run-v1/vision_rope.npz`、`tokenizer-v1/` 生成。
```jsonc
{
  "id": "qwen3vl-4b-review-v3", "display_name": "视觉语言模型 4B（告警复审）",
  "adapter": "qwen3vl_grouped", "capabilities": ["task:alarm-review-zh-v1", "decision_tokens"],
  "context_tokens": 1024,
  "image": {"formats": ["jpeg"], "width": 896, "height": 448, "tokens": 392, "fit": ["stretch_2to1"]},
  "programs": {"vision": ["vis-0-6","vis-6-12","vis-12-18","vis-18-24"],
               "text": [{"dir":"txt-0-8","layers":[0,9],"deepstack":3},{"dir":"txt-9-17","layers":[9,9]},
                        {"dir":"txt-18-26","layers":[18,9]},{"dir":"txt-27-35","layers":[27,9]}],
               "head": "head", "prefill": 256, "kv_capacity": 1024},
  "decision_vocabulary": ["是","否","A","B","C","D","E","F","0","1","2","3","4","5","6","7","8","9","Yes","No","yes","no"],
  "tasks": {"alarm-review-zh-v1": {"template_sha256": "…", "validated": {"agree_0_5_vs_bf16": 0.9767, "label_accuracy_0_5": 0.882, "auc": 0.978, "set": "final-559"}}},
  "files": [{"role": "…", "path": "…", "sha256": "…"}],
  "resources": {"ion_bytes_measured": 5500000000}
}
```

---

## 5. 对外接口

**任务接口（主路径）** `POST /v1/ainvr/tasks/alarm-review-zh-v1`（推理密钥）
```json
请求 {"image": {"jpeg_base64": "/9j/…"}, "alarm": {"kind": "人员", "description": "画面中出现人员"}, "request_id": "alarm-…"}
响应 {"schema": "ainvr.alarm_review.v1", "request_id": "alarm-…",
      "real_score": 0.9731, "score_kind": "two_way_softmax_uncalibrated",
      "logits": {"yes": 50.88, "no": 37.28}, "decision_logits": {"是": 50.88, "否": 37.28, "…": 0},
      "calibration_temperature": 1.0, "validated": true, "template": "alarm-review-zh-v1",
      "model": {"package_id": "qwen3vl-4b-review-v3", "package_sha256": "…"},
      "timing_ms": {"queue": 0, "preprocess": 15, "vision": 505, "text": 2040, "total": 2600}}
```
- `real_score` 是未校准的条件分数，不是概率；阈值由告警服务在独立数据上选定，并记录模型包 sha。分数分布很极端，可用阈值可能很小（10⁻⁵ 量级）。
- 长度按展开后真实 token 数检查，超出返回 400，不截断。
- 图片只收 JPU 实测支持的 JPEG；非 2:1 默认 400。

**OpenAI 兼容** `POST /v1/chat/completions`：本期模型包没有 `chat` 能力 → 返回 400 `capability_not_available`；决策打分可经 `extra_body.ainvr.decision` 调用，结果在 `ainvr` 扩展字段；不支持的 `logprobs` 明确拒绝。
**其他**：`GET /v1/models`；`GET /health`（不推理）；`GET /v1/status`（管理密钥）；`POST /v1/admin/load|unload`（管理密钥）。错误统一 `{"error":{"message","type","code"}}`：400/401/404/429 `queue_full`/503 `model_not_loaded|ion_insufficient`/504 `timeout`。

---

## 6. 性能

基线 2.83 s/次，BPU 计算占 90%。

| # | 改动 | 预期 | 验收门 | 时机 |
|---|---|---|---|---|
| E1 | C++ 零拷贝 + 硬件前处理 + 跨请求流水 | −0.1~0.2 s | G0 / 张量门 | P1 |
| E4 | 末 token 并入末块 prefill（去掉 4 次 s1） | −约 0.15 s | G1 | P3 |
| E5 | 片上缓存：编译 `max_l2m_size>0` + 运行时 `HB_DNN_USER_DEFINED_L2M_SIZES` | 未知 | G0 | 视需求 |
| E11 | 编译选项 `max_time_per_fc`（同 BC） | 降低对检测的抖动 | G0 + 检测延迟实测 | P4 前 |
| E6–E9 | balance、s512、算子热点、W8A8 | 未知 | G0/G1 | 视需求 |

G0：板上输出与当前 O2 编译器参考逐位相同。G1：开发集 157 项一致率不低于 97%、|Δp| 均值不高于 0.03，再在独立集只跑一次确认（不低于 97.3%）；独立集不用于调参。

---

## 7. BPU 内存预留

**原则：加载决策不依赖“实时剩余量”这个数。** 本板没有安全的剩余量来源：官方 `hb_mem` 只能查池总量；`/proc/meminfo` 的 MemAvailable/CmaFree 与 ION 池无关；内核诊断目录 `/sys/kernel/debug/ion` 读取会导致内核崩溃（`test/ION-DEBUGFS-FORBIDDEN.md`），**整个目录禁止读取**。

实测：ION 池 7.5 GiB（8053063680 B）；本模型 5.5 GB；LocateAnything 加载后 5.19 GB → 两者合计超出池容量，**互斥是实测结论**。

加载流程（llm-service，全部在共同锁内完成，协议见附录 B.2）：
1. 加锁；读登记表，清除已退出进程的条目。
2. **互斥**：登记表里已有其他大模型（如 LocateAnything，`loading` 或 `loaded`）→ 拒绝，返回 `large_model_busy`，不停止原模型。
3. **静态预算**：`池总量（先 hb_mem_module_open，再 hb_mem_get_heap_size 查询 HB_MEM_USAGE_PRIV_HEAP_2_RESERVED，最后 close；不能查询其他池代替）− 其他服务静态预算（当前固定 1024 MiB）− 余量（默认 512 MiB）≥ 本模型需求（包清单 `ion_bytes_measured`）`，否则拒绝。
4. 登记 `loading`，在锁内加载 HBM。加载失败 → 释放已分配的全部资源 → 删除登记 → 返回 `load_failed`（详情写日志）。
5. **加载后余量验证**：用与运行时相同的分配路径 `hbUCPMallocCached` 申请“余量”大小的缓冲并立即释放。申请失败 → 卸载模型 → 删除登记 → 返回 `ion_insufficient`。
6. 登记改为 `loaded`；模型就绪。**整个模型驻留期间持有排他锁，所有硬件资源释放后才解锁**；进程退出由内核释放锁。登记表记录 PID 与启动代次，仅作为身份校验，不能替代锁。

LocateAnything 执行器（Python）在首个请求懒加载前做同样的第 1、2、4、6 步（`fcntl.flock` 同一把锁、检查并写同一登记表），不需要做余量验证。
不自动停用现有 AI 通道；配置页和仪表盘显示登记表与各进程持有量（附录 B.1，仅展示）。

**启用前必须通过的验证**（可暂停 AI 服务进行，观测只用 `/health`、各服务日志和 fdinfo，不读诊断目录）：
- (a) 正常加载：LocateAnything 未加载时，本服务加载成功、余量验证通过、推理正常。
- (b) 双向拒绝：C++ 已持锁时 Python 必须在任何 HBM 加载前拒绝；Python 已持锁时 C++ 同样拒绝。覆盖正常释放、进程崩溃、登记表损坏和 SDK 清理失败；不得绕过共同锁在生产上故意超额分配。
- (c) 静态预算或加载失败必须保留旧配置；失败后禁用能完成确认，重试能重新申请。独立样本、持续运行及两路检测共存分别验收。

加载后的 512 MiB 试分配只证明该时刻可分配，不是未来余量保证。固定 1 GiB 预算不能代替真实视频通道的共存验收。当前界面仅报告加载状态、拒绝原因和请求耗时，不伪造实时剩余量。

## 8. BPU 时间
BPU 1 核，实测任务优先级不起作用（短任务优先级 255/0 均多等约 230 ms）。措施：提交时间配额（`submit_time_share`，默认 40%，10 s 滑窗，超限在调用间隙等待）；实验 E11。验收：2 路检测 + 连续复审 30 分钟，记录 ai-service 每帧推理耗时 p50/p95/最大与反压降帧；遵守“AI 每帧都存，存不过来只反压降帧”。

## 9. 超时、取消与故障
取消只在 BPU 调用间隙生效；单次 BPU 等待超时 → 隔离缓冲与任务、置故障、`/health` 报故障、systemd 重启；不复用在用缓冲；KV 每次请求重填。

---

## 10. 配置、页面、仪表盘

**配置文档** `llm-service / system / settings`（拉取模式）：
```jsonc
{
  "enabled": true,
  "listen": {"host": "127.0.0.1", "port": 8300},             // 固定，页面只读
  "api_keys": [{"name": "alarm-service", "scope": "inference", "key": "${secret:llm-service/api_keys/…}"}],
  "admin_key": "${secret:llm-service/admin_key}",
  "model": {"package_id": "qwen3vl-4b-review-v3", "load_policy": "resident", "ion_reserve_mb": 512},
  "tasks": {"alarm-review-zh-v1": {"calibration_temperature": 1.0, "aspect_policy": "reject"}},
  "scheduling": {"queue_size": 8, "queue_timeout_s": 30, "exec_timeout_s": 10, "submit_time_share_cap_percent": 40, "prefill_profile": "s256"},
  "logging": {"record_requests": false}
}
```

**系统配置页**：新分类 `['llm-service','大模型微服务配置','模型、复审参数、资源与调用']`
| 区块 | 内容 |
|---|---|
| 服务与调用 | 启用、状态、本机调用地址（只读，可复制）；推理/管理密钥的创建、轮换、吊销（不回显，留空保留） |
| 模型 | 模型包、校验状态、验证指标、加载/卸载、BPU 内存占用表 |
| 复审参数 | 校准温度（提示“改动会改变分数含义，阈值需重新评估”）、非 2:1 图片处理 |
| 资源与超时 | 队列长度、排队/执行超时、提交时间配额、prefill 档位（只能选已编译且验证过的） |
| 试一试 | 选图片、填告警类型与描述 → 显示属实分数、两侧 logit、各段耗时；不生成告警记录 |
文案不出现模型名、框架名（`noTechStackInUiText.test.ts`）；弹窗右上角“×”规范。

**Nginx**：`location /api/llm/ { proxy_pass http://127.0.0.1:3001/api/llm/; proxy_buffering off; proxy_cache off; proxy_read_timeout 450s; add_header X-Accel-Buffering no; }`

**仪表盘**：服务行“大模型服务”（以模型真正就绪为准）；状态卡 `LlmServiceStatusCard`（模型状态、ION、队列、按调用方计数、失败数、延迟分位、提交时间配额）；日志中心新增来源。

---

## 11. 构建与部署

### 11.1 构建环境（板上原生编译）
| 项 | 做法 |
|---|---|
| 系统依赖（已有） | cmake 3.22、g++ 11、cpp-httplib 0.10.3、nlohmann-json 3.10.5、GTest 1.11、hobot SDK（libdnn/libhbucp/libmultimedia/EGL/GLES） |
| Rust（编译 tokenizers-cpp 用） | 1.99.1，位于 `/mnt/ainvr-ssd/llm-build/rust/`；使用时 `export RUSTUP_HOME=/mnt/ainvr-ssd/llm-build/rust/rustup CARGO_HOME=/mnt/ainvr-ssd/llm-build/rust/cargo PATH=/mnt/ainvr-ssd/llm-build/toolshim:/mnt/ainvr-ssd/llm-build/rust/cargo/bin:$PATH`；crates 源已配置为清华镜像 |
| tokenizers-cpp | 源码 `/mnt/ainvr-ssd/llm-build/third_party/tokenizers-cpp`（commit `c586c52`，含子模块），CMake `add_subdirectory` 引入 |
| 编译器名 | tokenizers-cpp 在 aarch64 上写死 `aarch64-unknown-linux-gnu-gcc/g++/ar`；`/mnt/ainvr-ssd/llm-build/toolshim/` 里的同名软链接指向本机工具 |
| 网络 | 板子直连 GitHub 不稳定；需要下载时在构建命令里临时设 `https_proxy=http://192.168.100.182:7890`（`no_proxy` 含清华镜像），不写系统配置 |
| 构建目录 | 放 SSD；产物 `deploy/s100p/bin/ainvr_llm_service` |

### 11.2 部署
- systemd `ainvr-llm.service`：`User=sunrise`；`EnvironmentFile`/设备权限照抄 `ainvr-ai.service`（JPU/Mali 所需）；`LD_LIBRARY_PATH=/usr/hobot/lib`；`ExecStartPre` 校验模型包；`ProtectSystem=strict`，模型目录只读；`Restart=on-failure`；`MemoryMax` 按实测峰值。
- bootstrap `deploy/s100p/runtime/llm-service-bootstrap.json`（0600）；`deploy-package/init_board_config.py`、`validate_console_env.py` 增加 `CONFIG_SERVICE_TOKEN_LLM_SERVICE`；tmpfiles.d 创建 `/run/ainvr`（`d /run/ainvr 0770 sunrise sunrise -`）；服务单元加 `InaccessiblePaths=/sys/kernel/debug`。
- 发布：固定源码与模型包 sha、备份、受控替换、一键回滚；**部署前需用户同意，代码由用户提交**。

### 11.3 改动文件清单
| 位置 | 改动 |
|---|---|
| `llm-service/`（新） | `CMakeLists.txt`；`src/{main,http_api,request_queue,submit_budget,bpu_reservation,model_registry,adapter,qwen3vl_engine,bpu_program,package,task_template,image_pipeline,vision_runner,qwen3vl_layout,text_prefill,decision_head,scoring,config_apply}`；`shaders/qwen3vl_patchify_normalize.comp`；`tests/`；`tools/{build_package.py,reference_dump.py}` |
| `ai-service/runtime/locateanything_*executor*` | 加载入口接入 BPU 内存预留 |
| `shared/host-restart-helper/observability.py` | `llm-service` 单元/来源/健康；按 fdinfo 统计各进程 ION 持有量（仅展示） |
| `deploy/s100p/{ainvr-llm.service, runtime/llm-service-bootstrap.json, runtime/nginx.conf}` | 新 unit、bootstrap、`/api/llm/` 代理 |
| `srs-web-console/backend/src/{store/services.ts, store/llmConfigAdapter.ts, routes/configPolicy.ts, services/serviceTokens.ts, services/llmConnection.ts, routes/llmProxy.ts, routes/llmModelCatalog.ts, routes/observability.ts}` | 服务名单、校验、密钥、连接、代理、模型目录、日志源 |
| `srs-web-console/frontend/src/{pages/ConfigCenter/index.tsx, pages/ConfigCenter/LlmServiceConfigForm.tsx, pages/Dashboard/{format.ts,LlmServiceStatusCard.tsx,index.tsx}, api/llmService.ts}` | 配置页、仪表盘 |

---

## 12. 开发步骤

每步按“先写失败测试 → 实现 → 用参考数据验证”进行。

| 步 | 内容 | 产出 | 通过条件 |
|---|---|---|---|
| P1-1 | `build_package.py` 生成清单与数值表；`reference_dump.py` 用 Python 参考对开发集 20 条导出各段中间张量与 22 logit | 模型包 + 参考数据 | sha 校验通过；参考数据复现 v3 结果 |
| P1-2 | `bpu_program` + `vision_runner` + `text_prefill` + `decision_head`（输入用参考数据中的切块张量） | 引擎核心 | 20 条 22 logit 与参考逐位相同；纯 BPU 时间与 §1 一致 |
| P1-3 | `tokenizer` + `task_template` | 分词模块 | 10 万串 token id 与 HF `tokenizers` 完全一致；完整模板 `input_ids` 与评测集逐条一致 |
| P1-4 | `image_pipeline`（JPU + Mali 着色器） | 硬件前处理 | 896×448 源：与 numpy 切块逐位一致；原分辨率 JPEG：给出与 PC Pillow 9.3 的差异分布，独立集原图端到端一致率不低于 97.3% |
| P1-5 | HTTP 外壳：任务接口、`/v1/models`、`/health`、`/v1/status`、能力拒绝、错误格式、队列/超时/取消 | 服务二进制 | Python 与 Node OpenAI SDK 实调；队列满、断开、超时注入测试通过 |
| P1-6 | 板上隔离试跑（本机 8300，本地配置文件，不接配置中心） | 试跑报告 | 连续 1 小时复审无错误、无内存增长；与 ai-service 共存的检测耗时记录 |
| P2 | 配置中心、页面、仪表盘、日志、Nginx、BPU 内存预留 | 控制台集成 | 保存实际生效、失败不假成功、各状态显示正确 |
| P3 | E4 | — | G1 |
| P4 | 共存与恢复（含 E11） | 验收报告 | 不串 KV、不释放在途缓冲、检测/推流/录像达基线 |
| P5 | 部署 | 发布包 | 用户同意后执行 |

评测数据：`/mnt/ainvr-ssd/llm-eval/v1/`（开发集 157、独立集 559 原图与标注、BF16 参考）；打分脚本 `test/llm_service/score_review_compare_v1.py`。

---

## 附录 A：引擎实现规格

参考实现（测试基准，`test/model_conversion/qwen3vl/`）：`qwen3vl_host_v1.py`、`board_run_alarm_v1.py`、`qwen3vl_common_v1.py`。C++ 必须与之逐位一致。所有张量 dtype 为 F32，按 SDK 报告的对齐步长写入。

### A.1 常量
`H=448, W=896, PS=16, MERGE=2, TPS=2, GH=28, GW=56`；图像 token `151655`、视觉开始 `151652`；`HID=2560, NKV=8, HD=128`；MRoPE `θ=5,000,000, SECTION=(24,20,20)`；KV 容量 `C=1024`；prefill 档 `P=256`；掩码值 `-96`；视觉 token 392（14×28）。

### A.2 BPU 程序输入输出（`/mnt/ainvr-ssd/qwen3vl/*-o2-v3/<档位>/ports.json`）
| 程序 | 输入（按序） | 输出（按序） |
|---|---|---|
| 视觉组 0（块 0–5） | `patches [1568,1536]`、`vcos [1568,64]`、`vsin [1568,64]` | `h [1568,1024]`、`ds0 [392,2560]` |
| 视觉组 1（块 6–11） | `h [1568,1024]`、`vcos`、`vsin` | `h [1568,1024]`、`ds1 [392,2560]` |
| 视觉组 2（块 12–17） | 同上 | `h [1568,1024]`、`ds2 [392,2560]` |
| 视觉组 3（块 18–23 + 合并层） | 同上 | `merged [392,2560]` |
| 文字组 0（层 0–8），s256 / s1 | `x [P,2560]`、`cos [P,128]`、`sin [P,128]`、`mask [P,1024]`、`ds0/ds1/ds2 [P,2560]`、`k0,v0,…,k8,v8 [8,1024,128]`（共 25 个） | `h [P,2560]`、`k0',v0',…,k8',v8' [8,P,128]`（共 19 个） |
| 文字组 1–3 | `x`、`cos`、`sin`、`mask`、`k/v ×18`（共 22 个） | 同上（19 个） |
| 决策头 | `h_last [1,2560]` | `logits [1,22]`，顺序 `是,否,A,B,C,D,E,F,0..9,Yes,No,yes,no`（token id `20412,32376,32..37,15..24,9454,2753,9693,2152`） |
`vcos/vsin` 为包内固定表（`run-v1/vision_rope.npz`），四个视觉组共用。

### A.3 图片切块排布（着色器公式）
缩放后 RGB8 图 `rgb[y][x][c]`（896 宽 × 448 高）；归一化表 `LUT[k] = ((float32(k) * float32(1/255)) − 0.5) / 0.5`（float32，离线进包）。
`patches[r][col]`：`r = ((bh·28 + bw)·2 + mh)·2 + mw`，`col = ((c·2 + t)·16 + py)·16 + px`，`bh∈[0,14) bw∈[0,28) mh,mw∈{0,1} c∈{0,1,2} t∈{0,1} py,px∈[0,16)`；取值 `LUT[rgb[(bh·2+mh)·16+py][(bw·2+mw)·16+px][c]]`（t=0、1 两份相同）。

### A.4 位置与词向量
- 序列 `ids` 长度 L（评测集 466–477），图像 token 连续 392 个，起点 `s0`。
- 位置：`j<s0` 三轴均为 `j`；图像第 k 个：`t=s0, h=s0+⌊k/28⌋, w=s0+(k mod 28)`；图像之后 `p = s0 + 28 + (j − s0 − 392)`，三轴相同。
- MRoPE：`inv[i] = 1/θ^(2i/128)`（i∈[0,64)）；第 i 列用哪一轴：`i<60 且 i%3==1 → h`，`i<60 且 i%3==2 → w`，其余 → t；`cos[j][col] = cos(float32(pos_axis(col%64)) · inv[col%64])`（col∈[0,128)），sin 同理。包内存 `COS_TABLE[axis][p][i]`、`SIN_TABLE`（p∈[0,1024)），C++ 只查表拼行。
- 词向量：`hidden0[j] = bf16→f32(table[ids[j]])`（左移 16 位）；图像第 k 个位置替换为 `merged[k]`。
- DeepStack：`ds_full_m[j] = ds_m[k]`（j 为第 k 个图像位置），其余为 0；只进文字组 0。

### A.5 prefill 计划与每次调用
- 计划：`s=0; while L−1−s>0: q=min(256, L−1−s) → (start=s, q, P=256); s+=q`；最后 `(start=L−1, q=1, P=1)`。约束 `start + P ≤ 1024`。
- 输入（P 行）：
  - `x`：`r<q` 为 `hidden[start+r]`，其余 0；`cos/sin`：`r<q` 查表，其余 `cos=1, sin=0`；
  - `mask` 全填 `−96`；`r<q`：列 `[C−P−start, C−P)` 置 0，列 `C−P+j`（`j≤r`）置 0；若 `q<P`，行 `r≥q` 的列 `C−P` 置 0；
  - `ds0..2`（仅组 0）：`r<q` 为 `ds_full_m[start+r]`；
  - `k_i/v_i`：全 0；`start>0` 时位置 `[C−start, C)` 依次放历史第 0..start−1 行。
- 输出：`h` 前 q 行有效；`k_i'/v_i'` 前 q 行追加到第 i 层历史末尾。
- 组间：每组跑完整个计划后，所有调用的 `h` 前 q 行按序拼成 `[L,2560]` 作为下一组的 `hidden`；历史在组间清空。
- 决策头输入：组 3 最后一次（s1）输出的那一行。
- 零拷贝：18 个 `[8,1024,128]` 缓冲全局一份，4 组、两档共用；进入下一块前把已有历史整体左移 q 行、新行写到末尾（每头连续内存 memmove），只 flush 改动区。

### A.6 打分
`real_score = 1 / (1 + exp(−(logit_是 − logit_否) / T))`，`T` 为校准温度（默认 1.0）。

---

## 附录 B：集成接口约定

### B.1 ION 用量展示（只用于展示和归因，不参与加载决策）
- 采集助手在已有的 `/proc` 扫描中，读取每个进程 `/proc/<pid>/fdinfo/<fd>`：链接目标为 `/dmabuf:` 且 `exp_name: ion` 的条目，按 `ino` 去重累加 `size`，得到各进程 ION 持有量。
- 这是**下限**：不含驱动内部分配。页面标注“进程持有（不含驱动内部占用）”。**不得用“总量 − 持有量”推算剩余量。**
- 池总量用 `hb_mem_get_heap_size`（llm-service 启动时读取一次并在 `/v1/status` 返回）。
- 禁止读取 `/sys/kernel/debug/ion`。

### B.2 BPU 内存预留协议
- 锁 `/run/ainvr/bpu-reservation.lock`（`flock` 排他）；登记表 `/run/ainvr/bpu-reservations.json`：`{"holders":[{"service","pid","start_ticks","bytes","state":"loading|loaded","since_ms"}]}`；`start_ticks` 取 `/proc/<pid>/stat` 第 22 字段，防 pid 复用。
- 读登记表时删除进程已不存在（或 `start_ticks` 不符）的条目。
- 加载方在锁内完成：互斥检查 → 静态预算 → 登记 `loading` → 加载 → （llm-service）余量验证 → 改 `loaded`。任何一步失败都删除自己的条目。卸载完成后删除条目并释放锁；异常退出留下的登记由下一次获得锁的进程按 PID 与启动代次清理。
- 持锁加载期间，其他加载方阻塞等待（不轮询、不重试风暴）；锁等待设上限（默认 120 s），超时返回 `bpu_busy`。
- 接入方：llm-service；LocateAnything 执行器的懒加载入口。

### B.3 服务自身返回格式
- `/health`：`{"ready":bool,"model":"ready|loading|unloaded|ion_insufficient|verify_failed|fault","config_version":int,"package_id":str}`。
- `/v1/status`：`{"model":{…,"ion_bytes":…},"ion":{"total","used"},"queue":{"length","capacity"},"requests":{"<调用方>":{"ok","failed"}},"latency_ms":{"p50","p95"},"submit_time_share":{"window_s":10,"percent"},"last_error":{"at_ms","code","message"}}`。

### B.4 控制台后端
- `store/services.ts`：`CONFIG_SERVICES` 加 `'llm-service'`。
- `store/llmConfigAdapter.ts`（zod）：`listen.host=="127.0.0.1"`、`listen.port==8300`；`package_id` 匹配 `^[a-z0-9][a-z0-9.-]{1,63}$` 且存在于模型目录；`calibration_temperature∈[0.05,10]`；`queue_size∈[1,32]`；`queue_timeout_s∈[1,300]`；`exec_timeout_s∈[1,120]`；`submit_time_share_cap_percent∈[5,90]`；密钥 ≥32 字符且推理与管理密钥不同。
- `routes/configPolicy.ts`：`KNOWN_SECRET_PATHS['llm-service'] = [['admin_key'], ['api_keys','*','key']]`；`services/serviceTokens.ts`：`'llm-service': 'CONFIG_SERVICE_TOKEN_LLM_SERVICE'`。
- `routes/llmProxy.ts`（会话鉴权）：`GET /api/llm/status`、`GET /api/llm/models`、`GET /api/llm/catalog`（扫描 `ai-service/models/llm/*/llm-package.ainvr.json`）、`POST /api/llm/admin/load|unload`、`POST /api/llm/try`（图片 + 告警类型/描述 → 内部推理密钥 `console-try` 调任务接口）。
- `routes/observability.ts`：日志来源枚举加 `llm-service`。

### B.5 控制台前端
- `ConfigCenter/index.tsx`：`SERVICES` 加 `{ key:'llm-service', label:'大模型微服务', description:'模型、复审任务与资源' }`；分类加 `['llm-service','大模型微服务配置','模型、复审参数、资源与调用']`；新表单 `LlmServiceConfigForm.tsx`。
- `Dashboard/format.ts`：`names['llm-service']='大模型服务'`；新卡片 `LlmServiceStatusCard.tsx`（10 s 轮询 `/api/llm/status`）。

### B.6 采集助手
`observability.py`：`deployment_units()` 加 `'llm-service':'ainvr-llm.service'`；`SOURCES` 加 `'llm-service'`；健康探测 `http://127.0.0.1:8300/health`；`healthy = 单元 active 且 health.model=="ready"`；详情如“模型就绪 · 队列 0 · 最近 2.8 s”/“神经网络内存不足，未加载”。

### B.7 完成定义（全部满足才算开发完成）
1. P1-1 至 P1-6、P2 的通过条件全部满足，证据存 `test/results/llm-service-*/`。
2. 控制台：保存配置后服务回报已应用；“试一试”能出分；仪表盘显示真实就绪状态；日志中心能看到本服务日志。
3. 共存：BPU 内存预留双向生效（本服务已加载时 LocateAnything 加载被拒，反之亦然）；检测耗时记录在案。
4. 文档、脚本、模型包清单与本设计一致；部署前经用户同意，代码由用户提交。

---

## 附录 C：运维注意
- 实测数据：`test/results/llm-service-p0/`（纯 BPU 计时、优先级、LocateAnything ION），脚本 `test/llm_service/`。
- ION 池 7.5 GiB 已到单个内存段上限；`/boot/hobot/rdk-s100p-v1p0.dtb.bak` 是 1 GiB 的原始设置，**`hb_switch_ion.sh default` 会恢复它并导致现有模型全部加载失败，不得执行**。扩容需改设备树并重启，不在本期。
- 系统盘：10-22 已清理（只搬移），可用 21 GB；模型包放 `ai-service/models/llm/`。

# AINVR 大模型微服务：设计评审与实施契约

日期：2026-10-22。性质：设计，不代表功能已实现或模型已具备聊天能力。

## 1. 评审对象与结论

用户提到的本机路径未直接找到；实际文件位于 `AppData/Local/Temp/claude/D--code-kakadeai/b2c7a1b6-13b0-45fb-b5fc-3bae5721d97e/scratchpad/S100P-LLM-SERVICE-DESIGN.md`，与远程 `docs/S100P-LLM-SERVICE-DESIGN.md` 的 SHA256 完全相同（2c3d80ce9e5ce81f07fd472ed72690a4c9d6bbeeff647d2460f5bd18d5565ec1）。原稿保留，不覆盖其已有研究与决定记录。

独立服务、常驻模型、有界队列、硬件预处理、接入统一配置中心和仪表盘的方向正确。但原稿 v0.2 的交付是“固定模板、22 个决策 token、单次是/否判定”，不是用户此次提出的通用文字与图片对话服务。两者必须以模型能力分开验收，不能凭兼容 URL 宣称完成聊天。

原稿记载“用户决定暂不做自由对话”。该记载与本次请求存在范围差异：本方案保留复审作为可先交付的能力，但把通用聊天明确列为单独必备里程碑；未经确认不能把复审版替代整项通用服务需求。此次不实施告警业务复核，不改通知或告警确认逻辑。

## 2. 官方与开源调研

1. 地瓜官方有 [oellm_server](https://github.com/D-Robotics/oellm_server)，基于 `libxlm`，提供 `/health`、`/v1/models`、`/v1/chat/completions` 和 SSE。原稿“官方无 HTTP”只能描述底层动态库，不能用于概括官方方案。
2. 阅读其 `develop/openai_server.py`：当前 messages 数组仅保留 text part，推理请求固定为文字类型，HTTPServer 为单请求处理方式。现成代码不能直接满足图片输入、独立健康检查和 AINVR 配置协议，可作为官方 ABI、回调和协议的参考，不能照搬为生产服务。
3. 官方 [S100/S100P 工具链](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/LLM_Toolchain/s100_LLM_Toolchain) 已公布 Qwen2.5-Omni-3B 支持。该原生后端可作为通用多模态候选，必须对本机 SDK 实测；官方公布的 S600 Qwen3-VL 支持不能当作 S100P 的运行兼容证据。
4. 官方 [hobot_llamacpp](https://github.com/D-Robotics/hobot_llamacpp) 的相关组合采用视觉 HBM 和语言 GGUF。不能据此认定语言解码全在 S100P BPU 上。AINVR 现有全 BPU 推理要求仍适用。
5. Ollama 的 OpenAI 接口与模型执行后端是两件事。未找到可直接加载本项目分组 HBM 的现成后端。vLLM 等并非一概依赖 CUDA，其有平台插件体系；但开发 S100P 后端不是“装包即可”，本项目暂不承担完整平台插件工程。

建议：自建薄的 AINVR 服务与生命周期层，复用成熟协议库；后面接可替换的运行时适配器。优先验证官方运行时能否承载目标模型，分组 HBM 路径保留自主编排。协议层不重新实现模型算子。

## 3. 必须修订的原稿内容

| 项目 | 修订要求 |
|---|---|
| 通用聊天 | 当前 `build_head_v1.py` 只有 22 行决策头；补全词表头只是必要条件，还需逐 token 解码、KV、MRoPE/DeepStack、停止条件、分词与输出解码验证，不能写成“补头即可” |
| OpenAI logprobs | 22 token 内归一化不是全词表概率。复审分数放独立扩展结果；普通 `logprobs` 在未实现正确口径前明确拒绝 |
| 属实概率 | 是/否二选一 softmax 是条件分数，未经真实场景校准不能宣称可信概率；97.67% 是与 BF16 的判定一致率，不是现实准确率 |
| 内存 | 本地模型报告 5.50 GB ION、0.22 GB RSS 是特定测试口径；不能把官方 Omni 的“总内存 5.5 GB”当作其 ION 数字；加入 embedding 驻留、页缓存、临时张量、KV、预处理和换模峰值 |
| 硬件资源锁 | 只在配置页双向禁止不足以避免同时申请。加载执行方和 LocateAnything 懒加载方都必须使用共同资源预留协议；未知进程占用、碎片和最大连续块仍需处理 |
| 上线互斥 | 不自动停用现有 AI 通道。确实资源不足时给出占用者与处理选择，不将不同模型永久互斥当作已测定结论 |
| 系统盘与 SSD | 目录放置遵守原稿已记载的选择，但重新检查当前可用空间，不自动执行清理、改 ION 或重启 |
| BPU 占用比例 | 主机调用墙钟包含拷贝、调度、等待，不等于硬件忙时。服务“提交时间配额”和整机 BPU 采样分开命名 |
| 提速推断 | Omni 与本模型的结构、上下文和计时口径不同，不能从其 TPS/TTFT 推导必然还有 2–3 倍。先分离纯设备、拷贝、预处理、排队耗时 |
| JPEG 支持 | 不预先承诺渐进 JPEG、8192×8192 全部可解。按现有 JPU 的真实格式、分辨率、像素格式测试声明支持；不支持就明确返回错误 |
| 输入分辨率 | 896×448 是当前包的编译契约，不是所有 Qwen3-VL 的唯一输入尺寸；图片变换随包声明，形变或补边路径独立验证 |
| 字符数 | 64 字不能证明总长度 ≤512。必须在模板展开和图片 token 计入后按真实 token 数检查，并保留输出预算 |
| 超时与取消 | HTTP 超时不代表设备已停止；不得提前释放仍在使用的缓冲或并行复用句柄。不可取消的任务必须等安全边界或隔离进程恢复 |
| MemoryMax | 不直接照抄 1.5G。以本服务 cgroup 的实际内存与页缓存计费峰值设置，ION 单独监测，禁止靠试错挤爆生产进程 |
| 发布范围 | 本步骤建设通用调用基础；告警复核消费、阈值、结果入告警库属于后续业务，不能混进基础服务里 |

## 4. 建议服务分层

```text
其他本机微服务 ── OpenAI SDK / HTTP ─────────────┐
浏览器 ── 控制台后端（会话鉴权、SSE 转发） ──────┤
                                               ▼
ainvr-llm.service：协议、鉴权、有界调度、配置、模型注册与监视
        ├─ OfficialXlmBackend：官方 libxlm 支持的包
        └─ Qwen3VlGroupedBackend：本项目分组 HBM 编排
                                               ▼
                         JPU / GLES / BPU，KV 与模型常驻
```

对外是一个逻辑微服务，不要求所有模块必须同一进程。推荐网关与原生引擎子进程隔离：设备异常不拖死健康、配置、取消接口。可以采用已有 C++ HTTP 框架和原生引擎，也可以先用现有 Node 服务骨架作网关；选择依据是库复用和故障隔离，不能因为“Python 慢”就把整个协议层改写成 C++。

推理适配器提供 `inspect/load/warmup/generate/cancel/unload/status`。`generate` 产出 token/文本增量；一次性返回由同一生成流程聚合，避免两套结果不一致。第一版单引擎活动请求数为 1、有界等待；常驻权重不等于复用不同用户的 KV。

健康与配置请求独立响应，生成线程不得持有控制平面全局锁。卸载/换模按 draining → 等待或取消 → 安全释放 → 加载/预热执行；容量不足不承诺同时保留两套模型。失败回滚时允许明确显示旧模型正在重新加载，不假报“无缝回滚”。

## 5. 模型包与能力

模型配置以 `package_manifest` 为入口，不能只输入一个 HBM 文件路径。清单包含：稳定模型 ID、显示名称、后端类型、目标芯片、SDK/runtime 版本、所有 HBM/embedding/tokenizer/template/词表文件及 SHA256、输入尺寸/预处理契约、profile、最大上下文、输出头类型、EOS、实测峰值、质量报告与能力。

能力至少区分：`text_chat`、`image_chat`、`streaming_generation`、`alarm_review`、`logprobs`、`json_schema`。当前 v3 只声明已验证的复审/决策能力；通用聊天模型注册前必须通过完整解码验收。加载检查文件快照，拒绝越出许可目录的路径及链接；缺包或 ABI 不匹配明确报错。

未来补全词表模型可以有新 ID `ainvr-qwen3vl-4b-chat`；原复审模型保留独立 ID，不能默默改变旧调用的输出语义。

## 6. 对外协议契约

基础地址默认 `http://127.0.0.1:8300/v1`。监听主机默认锁定回环；端口作为高级配置可编辑、校验冲突、通过本服务受控重启应用。不开放公网访问；将来开放需独立入口策略。浏览器只通过 Web 后端访问。

- `GET /v1/models` 必须返回 `{ "object":"list", "data":[...] }`；原稿裸数组形式不兼容。
- `POST /v1/chat/completions` 支持 system/user/assistant messages，text 与 image_url 内容部分；初版图片只支持经过验证的 JPEG data URL，最多一张。拒绝外链图片和服务器任意路径。多轮由调用方完整传 messages，服务不隐式共用历史。
- 真正聊天包支持 `stream:false/true`。包含稳定 id/object/created/model/choices、assistant content、finish_reason，以及实际 usage。
- SSE 首块 role=assistant，中间逐步 delta.content，末块 finish_reason=stop 或 length；支持 include_usage 的最终统计块与 `[DONE]`。UTF-8 及跨块 stop 序列不得破坏文本，非流式与流式在同输入、种子、参数下聚合结果一致。
- 网关与 Nginx 对本代理路由关闭响应缓冲，设置合理读超时/保活；不能全站关闭缓冲。现网通用 `/api/` 位置尚没有专用 SSE 配置，必须补接。
- 模板展开后校验 input_tokens + max_completion_tokens ≤ compiled_context。支持 max_tokens 作为兼容别名，同时传冲突值明确拒绝。
- 采样参数 temperature/top_p/seed/stop 仅在后端真实支持时接受；后端不支持的 tools、response_format、logprobs、n>1 等明确返回参数错误，不静默忽略。top_k 属扩展参数，不当成 OpenAI 标准字段。
- 客户端断开立即撤销等待队列项，活动任务在安全边界停止；不能继续无限生成。排队、首字、执行、总截止分开统计。
- 错误统一 `{error:{message,type,param,code}}`。流已开始后不能再变成 HTTP 500；发送错误事件并关闭，调用方据此认定不完整。
- API key 按调用方分配，单独管理权限与配额；管理 API 不能仅凭推理 key 执行。默认不记录提示词、图片、响应正文；操作记录保留请求 ID、调用方、模型 hash、配置版本与耗时。

复审专用接口可以保留 `/v1/ainvr/alarm-review`，输出原始 logit、条件分数、模板/包版本与校准状态。22 token 模型若提供 SDK 适配，明确标记为受限模型，不把其分数塞进标准全词表 logprobs。本期不替其他微服务决定是否发送告警。

## 7. 资源与共存

启动先服务就绪、模型加载状态独立显示。模型状态机：disabled/unloaded/loading/warming/ready/draining/unloading/failed/insufficient_resources。

资源预留必须发生在真正分配前，覆盖所有会加载大模型的入口与懒加载服务。初版使用单一资源协调者或共享 OS 锁协议，带所有者/代次和存活校验；进程崩溃不留下永久占用。内存查询与分配间存在竞争，故预检查通过不等于一定能加载，实际失败必须完整回收。未知外部占用不自动终止。

默认常驻一个包、一个推理请求；KV 请求隔离。缓存命中键至少含模型 hash、模板、完整前缀及图片 hash、租户，不预先做跨用户复用。磁盘空间、RSS、cgroup、ION 分开显示；不从 RSS 推断可用 BPU 内存。

优先级与插入等待只能按本机 API 和实测保证描述。设置大模型占用配额时记录具体测量口径；先测分组长任务对现有 2 路检测 p95、归档反压、录像和推流的影响。重启改内存布局属于维护任务，本次设计不执行。

## 8. 配置中心与 UI

系统配置新增“大模型微服务配置”，卡片副标题“模型、生成参数、调用与资源”。遵循现有表单、保存应用状态和 44px 触摸区域，不另做孤立设置系统。

| 区块 | 控件与交互 |
|---|---|
| 服务 | 启用、状态、只读本机地址；高级设置可修改端口。复制 SDK base_url，不复制带密钥 URL |
| 模型 | 选择已安装包；高级项显示模型包路径、重新扫描；显示名称、能力、上下文与图片支持。加载/卸载说明影响，不能与未保存的包选择混用 |
| 生成默认值 | temperature、top_p、最大输出 token、stop；只对具备聊天生成能力的包显示。请求参数覆盖默认值，但不能超过资源上限；复审校准温度单独命名 |
| 资源与超时 | 常驻/按需、空闲卸载、并发上限、队列长度、等待/执行超时、内存保留。高级性能 profile 只能选已编译且验证过的档位 |
| 调用与鉴权 | 命名 key 的创建、轮换、吊销；密钥不回显，留空保留；管理调用与推理调用权限分离 |
| 试一试 | 图片选择/移除、提示词、流式开关、发送、停止、清空；输出可复制，展示排队/首字/总耗时/token/s，不自动生成任何告警记录 |

无聊天能力的复审包显示专用图片/描述试验，不显示无效生成控件，也不能把其一个字输出当作通用聊天验收。模型名称 Qwen3-VL 对选型有意义，可以显示；用户界面不暴露内部表名、编译器参数、动态库路径和日志堆栈。

表单保存必须保留 expected version/并发冲突处理。应用状态区分“配置已接收”“模型加载中”“已应用”“失败并恢复”；只有监听与已选模型按目标版本实际生效，才上报 applied。采样默认值热更且在请求进入时冻结；端口修改通过受控重启；换包先预检再 draining。

普通设置沿用全站单次保存；试验是独立操作，不隐式保存表单。弹窗均有 ×，与取消一致；未保存修改确认放弃，关闭不触发加载或写库。

## 9. 对现有代码的接线清单

- `backend/src/store/services.ts` 的 CONFIG_SERVICES、配置 adapter 注册、PullModeAdapter/服务拉取、service token/bootstrap 生成与部署校验均添加 llm-service；不能仅加前端分类。
- 复用 PG 配置版本、secret store、KNOWN_SECRET_PATHS、运行上报机制；只读状态/模型目录代理使用已应用连接配置，不能拿未生效的新端口探测旧实例。
- 前端 ConfigCenter 的 SERVICES 与 categories 同步，补 LlmServiceConfigForm、状态与试验客户端。
- Web 后端新增 `/api/llm/*` 代理：有会话鉴权，流式保持 backpressure、取消与错误，限制请求体和图片像素，不整段缓冲。
- `shared/host-restart-helper/observability.py` 的 service map/SOURCES、部署 unit 映射、日志与资源历史、frontend/backend source 枚举都添加 llm-service。restart helper 当前只允许 AI/录像，新增受控目标必须明确权限和动作；大模型没有必要因每次调参重启。
- 新增 `deploy/s100p/ainvr-llm.service` 与安装、回滚脚本；引擎所需权限最小化，依赖模型所在挂载点时明确 RequiresMountsFor。日志不含 key/图片。
- 后端与前端仪表盘新增服务行和详情卡；安装/启用才加入核心服务健康分母，未安装或停用显示相应状态，不把缺席当异常，也不能假报健康。
- 详细监视展示模型实际加载状态、队列、当前调用、请求成功/失败/取消、TTFT、prefill/decode、总耗时 p50/p95、RSS/ION、配置版本、日志入口。进程 active 不代表模型 ready。
- 此阶段不向告警引擎、流量计数器或通知路径加入 VLM 调用，不创建额外业务数据库。

## 10. 实施阶段与通过条件

| 顺序 | 重点目标 | 完成条件 |
|---|---|---|
| 1 能力冻结 | 对照当前 22 token 包、官方 Omni 后端与 Qwen3-VL 目标，分开复审/聊天 | 模型清单与接口兼容矩阵，不用纯接口冒充生成能力 |
| 2 引擎验证 | 先官方 backend 冒烟；自研分组路径补全词表与多步解码 | 真实文字、图片、中文和连续生成；记录实际内存与速度；质量独立验收 |
| 3 协议与隔离 | 统一 generate，流式/非流式、key、取消、限流、错误 | Python/Node OpenAI SDK 使用自定义 base_url 实际调用；至少多块增量输出，不只是最终一次包装 |
| 4 硬件输入 | JPU/GLES 输入 JPEG 与模型前处理契约 | 原图到张量、最终输出比对；不支持格式明确拒绝，无隐式 CPU 推理/像素回退 |
| 5 配置与监视 | PG、服务上报、系统设置、仪表盘、日志、SSE 代理 | 保存后实际生效，超时/失败不假成功；未安装/停用/加载/故障显示正确 |
| 6 共存与恢复 | 正常负载、队列满、客户端断开、换模、进程崩溃、内存不足 | 不串 KV、不释放在途缓冲，原通道/推流/录像达到约定基线；资源研究不等于生产许可 |
| 7 部署验收 | 固定源码/包 hash、备份、事务替换、健康与页面验收 | 受控发布与回滚，记录运行包、配置版本和服务指标；用户自行提交代码 |

本设计不承诺 1.5 秒延迟、固定 token/s 或仅增加 0.4 GB 就完成聊天。先做小范围可复现引擎验证，再估编译、共存与产品接线工作量。

## 11. 参考与核对范围

- 官方服务器及源码：https://github.com/D-Robotics/oellm_server ，https://raw.githubusercontent.com/D-Robotics/oellm_server/develop/openai_server.py
- 官方 S100 工具链：https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/LLM_Toolchain/s100_LLM_Toolchain
- 官方 S600 工具链（不可当作 S100P 兼容证明）：https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/LLM_Toolchain/rdk_s600/s100_LLM_Toolchain_v1_0_5
- vLLM 平台插件：https://github.com/vllm-project/vllm/blob/main/docs/design/plugin_system.md
- Chat Completions 协议：https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- 本地核对：模型构建/板测脚本、当前配置服务名单与配置页、observability/restart helper、现网 Nginx 配置。此次没有运行模型、改内存布局、停止服务或部署。

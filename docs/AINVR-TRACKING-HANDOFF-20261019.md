# AINVR 第一阶段交接：目标跟踪、轨迹与实时预览绘制

更新：2026-10-19 晚（北京时间）。以用户最新明确范围为准。旧版交接在文件末尾HTML注释内，仅用于历史追溯，其中更大的目标、待办和验收不再适用于本阶段。

## 1. 唯一当前目标

**实现目标跟踪、生成轨迹，并像现有检测框一样把它们绘制在实时预览视频上；完成必要测试、部署和真实浏览器验收。**

当前交付包括：
- 同一视频会话中的目标关联和稳定ID。
- 按源视频时间生成有界轨迹，区分目标，短时遮挡后合理恢复或终止。
- 服务输出携带轨迹绘制所需身份、位置和时间信息，沿用现有SEI视频对齐链路。
- AI设置可开启/关闭跟踪；实时播放器有独立“显示轨迹”开关。
- 轨迹跟随正在显示的视频帧，不能把最新推理结果直接画在延迟画面上。

卡尔曼预测等只是跟踪器内部实现手段，不另做“运动估计”产品功能或速度面板。用户要求短时丢失按运动推算补框（4.9）：推算框与推算轨迹段一律虚线并标“推算”，不冒充真实观测，不进归档/统计/告警。

**本阶段明确不做：** 流量统计、区域布防、出现/接近/接触或碰撞/进入/穿越判断、规则编辑、事件中心、轨迹历史查询与独立轨迹存储产品、大模型复核、报警和通知。已有实验和代码保留，不再继续扩展，也不作为第一阶段上线的前置条件。

## 2. 当前状态（2026-10-19 晚）

**现网**：大门通道已由用户切换为 YOLO26x、计划10fps（实测约9.8fps）、开启跟踪，用户已在实时预览中看到编号与轨迹并给出反馈（见4.6）。AI、录像、LocateAnything 后端服务均 active。现网服务二进制 = `out/build/ai-s100p/ainvr_s100p_control_service`（4.7 修复后重新部署），前端 dist 为最新构建。所有改动均未提交；提交方案已备好（4.7），等用户指示。

| 第一阶段能力 | 已完成并有证据 | 仍未完成 |
|---|---|---|
| 跟踪核心 | ByteTrack/运动关联/Kalman；楼梯视频逐人核对（4.5）；**丢失轨迹二次关联已上线**（4.7）：BPU 重跑 5fps 与逐帧均 6人6ID、0断裂、0互换 | 出入画、静止、长间隔、断流用例 |
| 轨迹数据输出 | SEI/会话ID/源PTS；现网实测YOLO26x 5fps 2分钟：600帧SEI 600次、0错误、131条轨迹（`test/results/analytics/live-tracking-gate-v1.json`，测后配置原样恢复） | 长时间运行内存/SEI 有界观察 |
| 预览绘制 | 框上 #编号、按ID着色轨迹、“轨迹”按钮；锚点改框中心、历史30秒/360点（4.6）；跟踪会话变化立即清空旧轨迹（4.7）；均已上线 | 由本会话做的浏览器验收（需用户登录）：对齐、黑边/缩放、多窗口、换流、延迟流 |
| UI配置 | 第3步“目标跟踪”，只显示跟踪开关与如实说明；隐藏旧配置原样保留、不阻止保存（4.4） | 页面保存/刷新/关闭/重开实际操作记录 |
| 额外功能屏蔽 | **已实施并上线（4.4）**：前端不挂载规则/事件/复核/通知、卡片无“区域事件”；服务端只运行跟踪，现网验证新开启复核/通知/规则均 422、事件接口 404、配置不变；`/health` 能力与门控一致（4.7） | 运行级验证未做：接口已拒绝写入这类配置，只能改现网配置文件并重启才能构造，侵入过大；现有证据为门控单测+worker 调用点逐行核查 |
| 部署 | 服务与前端已事务部署两次（回滚备份见7节），原大门通道回归正常 | 整体验收结论、提交（等用户指示） |

第一阶段整体**尚未验收完成**：缺浏览器验收证据和上表“仍未完成”项。

## 3. 下一步（按顺序）

1. 用户说“提交”时执行 `bash /home/sunrise/ainvr-commit-plan-20261019/commit-plan.sh commit`（先 `check`）：两笔提交，见4.7。不推送。
2. 用户登录浏览器后做实时预览验收：编号/轨迹与框对齐（含黑边与缩放）、轨迹按钮即时生效且不重启、多窗口不串轨、换流/重连清空、延迟流按显示帧绘制。截图留证，测后恢复配置。
3. 补充视频用例：出入画、静止、长时间遮挡、断流重连；长时间运行观察（内存、SEI、轨迹点数）。
4. 用户已决定下一阶段开发报警服务：按第1节业务顺序，先设计出现/接近/接触/进入/穿越与告警决策，再接入（届时打开对应阶段开关并重新验收），VLM 复核在决定发告警时才接入。

不要继续VLM输入tensor对照、复核误报、模型共享调度、规则丰富化、通知发送或统计页面开发；本阶段与 LocateAnything 无关。

## 4. 如何屏蔽额外未完成工作（已实施，记录见4.4）

### 4.1 UI屏蔽

现源码 `srs-web-console/frontend/src/pages/AiChannels/AiChannelWizard.tsx`：步骤名仍为“跟踪与规则”，且开启analytics后同时渲染 AnalyticsRuleEditor、AnalyticsReviewSettings、AnalyticsNotificationSettings。**只改文案不足以屏蔽。**

需要：
- 步骤名改为“目标跟踪”，删除规则/布防/告警等产品说明；只保留跟踪启用、算法能力、必要关联参数和采样限制说明。
- 不挂载上述三个额外设置组件。用明确的产品功能开关/能力门控控制，而非仅CSS隐藏。
- 同步排查智能事件、统计、轨迹历史、保存轨迹、复核及通知相关菜单、按钮、路由和直达链接；本阶段不显示，直接访问给出未开放/不可用状态，不呈现半成品。
- 实时预览只提供本阶段已有检测框及轨迹/必要ID显示；不开放规则区域、预测轨迹、速度与报警叠加。
- 隐藏字段不参与当前表单必填/步骤校验；新建通道不附带有效规则、复核或通知。不能因为隐藏的旧规则非法而阻止保存跟踪开关。
- 编辑已有配置时，不把未显示字段悄悄清空或覆盖；采用局部patch或明确保留策略。是否执行这些配置由服务端功能门控决定。

### 4.2 服务端屏蔽

只隐藏前端不能保证不运行。核对 pipeline/reused_channel_worker、frame_analytics 和 control_server 中的接线：
- 跟踪启用必须独立于规则/事件/复核/通知。不要关闭整个analytics总开关导致跟踪也不能用。
- 本阶段产品能力在服务端明确限制：规则求值、事件生成与异步事件outbox、独立轨迹历史写入、VLM复核worker、通知worker不创建/不入队/不发送。不要在worker里跑完后仅丢弃结果。
- 对请求启用未开放功能的API调用明确返回不可用/不支持，不能接受成功却静默执行；已有历史配置保留但不生效，不删除历史事件或待办。
- 不因有旧的queued事件就启动消费者补发通知。
- 保留现有正常检测归档、录像、SEI、SRS及现有LocateAnything检测器服务。**延期VLM复核不等于停掉用户当前的开放词汇检测模型。**
- 复用的事件存储或配置结构需要拆清调用边界；不能为了屏蔽新事件功能破坏原识别历史。

### 4.3 屏蔽验收

- 新建/编辑/刷新页面只见第一阶段入口；直达未开放页面也不能启用功能。
- 跟踪开启后持续输出ID和轨迹，现有检测归档继续正常。
- 通过隔离配置含旧规则/复核/通知字段的测试确认：不启动额外worker、不新建事件/任务、不产生外发请求。
- 用本地测试接收器/桩验证没有通知，不访问真实外部通知目标。
- 并发编辑或保存跟踪开关不能删除隐藏的用户配置。
- 文档、UI、服务端能力必须一致；所有屏蔽结果需要测试或运行证据。

### 4.4 实施记录（2026-10-19 下午）

- 服务端：`analytics/config.hpp` 新增 `kRulesAndEventsAvailable/kReviewAvailable/kNotificationAvailable=false`、`PhaseEffective()`（运行配置只保留跟踪：清规则、save_events=false、复核/通知关闭，存储的用户配置不改）、`PhaseUnavailableRequest()`。worker 的启动校验、事件存储/复核/通知 worker 创建、FrameAnalytics 与事件提交全部只认生效配置；`control_server` 新建/修改时新开启规则/复核/通知返回 422 feature_unavailable（原样保留旧值可保存）；`/analytics/events` 返回 404 feature_unavailable。测试 `test/ai_port/analytics_phase_test.cpp`（注册在 test/bytetrack/CMakeLists.txt 的 analytics_phase_gate）。
- 前端：`features/analyticsPhase.ts` 的 `ANALYTICS_PHASE` 能力开关；向导第3步改名“目标跟踪”，不挂载事件保存/规则编辑/复核/通知组件，文案只讲编号与轨迹；`validateVisibleAnalytics` 只校验可见设置，隐藏旧配置不阻止保存且编辑时原样带回；通道卡片不显示“区域事件”按钮与待保存提示。顺带把向导里的“SRS 通道”改为“流媒体通道”（技术栈文字守护测试）。前端全量 913 项通过。
- 未完成：部署后的浏览器实测（需用户登录）、真实视频逐人ID核对、长时间运行与多窗口。

### 4.5 楼梯视频逐人身份核对（2026-10-19 下午）

报告 `test/results/analytics/corridor-identity-annotation-v1.json`；对照图 `corridor-identity-review-v1/`（逐帧）、`corridor-identity-review-stride5-v1/`（每5帧，约5fps），渲染脚本 `test/ai_port/render_corridor_tracks_v1.py`（只读输入）。

| 运行 | 真实人数 | 人员轨迹数 | ID互换 | 断裂 | 无编号的人员框 |
|---|---|---|---|---|---|
| 逐帧 | 6 | 6 | 0 | 0 | 105/1109（9.5%） |
| 约5fps | 6 | 7 | 0 | 1 | 33/222（15%） |

- 5fps 断裂：P4（拎桶者）ID9 在第270帧最后观测，275/280连续漏检，285帧重现时框中心跳动约420像素（下楼梯到平台），IoU为零，楼梯上慢速估计的速度也预测不到这一步，新建ID19。逐帧运行同一人未断（第280帧漏检后仍接回ID11）。
- 无编号框来源：新目标确认前、两人合并成一个大框时未匹配。预览中这些框显示为不带#编号的检测框。
- 结论边界：一段视频、6人、按衣着目视核对8张抽样截图+全景表，不是统计精度。后续候选改进：丢失轨迹按运动补偿的中心距离/尺度做二次关联（观测中心恢复），需再用本视频回归对比。

### 4.6 用户首次页面反馈（2026-10-19 下午，已上线）

用户在大门通道（YOLO26x，计划10fps，开启跟踪）实际看到轨迹后要求：轨迹点用识别框正中心而非下边缘；轨迹历史加长为原来3倍。已改 `components/player/trackTrails.ts`：锚点 `y+h/2`，默认保留30秒（原10秒）、每条最多360点（原120，10fps时30秒不截断），工具栏提示改“最近30秒”；`test/trackTrails.test.ts` 先红后绿，前端全量914通过，前端已构建上线（旧dist备份 `/home/sunrise/ainvr-merge-backup-20261019/frontend-dist-before-trail-centre`）。服务端规则判定用的锚点未改动（规则本阶段不开放）。

### 4.7 提交前修复（2026-10-19 晚，评审意见+本会话建议，均已上线）

- **换跟踪会话旧轨迹残留**（评审P2）：`trackTrails.ts` 从 track_id（“<会话>:<编号>”）取会话，出现新会话即清空旧轨迹，同会话多目标保留；`trackTrails.test.ts` 先红后绿（替换了原“两会话并存”的旧断言）。
- **能力接口与门控矛盾**（评审P2）：`analytics::PhaseCapabilities()` 统一生成 target_tracking/analytics_rules_events/target_presence_review/analytics_notifications；`control_server` 在合并 `s100p_control_service` 运行时信息之后写入（现网入口的 capabilities 原本会整块覆盖）。现网 `/health` 实测 tracking=true、其余=false；`analytics_phase_test` 增加断言。
- **5fps 断裂修复**：`bytetrack_adapter.hpp` 新增丢失轨迹二次关联——ByteTrack 新内部ID与同类别、未超 max_gap_seconds、本帧未出现的丢失身份，按运动外推中心距离≤1个框对角线且面积比≤2.25 一对一贪心匹配；复活的重复内部ID保留自身ID，避免同帧重复。测试 `test/ai_port/bytetrack_recovery_test.cpp`（4例：跳跃恢复/过远新ID/不抢在跟目标/超时不恢复，先红后绿）。BPU 重跑楼梯视频：`corridor-bpu-tracking-recovery-stride5-v5.json`、`...-stride1-v5.json`，按人工标注对比 `corridor-recovery-comparison-v5.json`：两种帧率均 6人6ID、0断裂、0互换，检测数与此前一致。
- 验证：服务7、跟踪8、分析核心3、前端915项全部通过，`git diff --check` 干净；服务与前端已事务部署，大门通道 running、配置不变。
- **提交方案**（未执行）：`/home/sunrise/ainvr-commit-plan-20261019/`（本机副本 `D:\codex-task-staging\ainvr-analytics\commit-plan-20261019\`）。第1笔 LocateAnything 多类别 = 独立工作树 `/home/sunrise/ainvr-la-multi` 相对HEAD的补丁（共享文件只含LA代码块）+6个LA新文件；第2笔 = 其余全部（含 analytics 源码、trackTrails、阶段开关、第三方 ByteTrack 源码与 LICENSE/UPSTREAM）。`.gitignore` 新增 `deploy/s100p/rollback-ai-*/`，新回滚二进制不入库（历史已入库的不受影响）；test/results 本就忽略。`check` 演练通过，暂存区为空。

### 4.8 跟踪身份层重构（2026-10-19 晚，已上线，未提交）

**用户反馈**：10fps 下轨迹经常断、ID 变化。**现网录制分析**（`test/results/analytics/live-gate-10fps-record-v1.json`，3分钟1809帧）：27 次“ID消失后附近出现新ID”，其中25次期间该人一直被检测到但未分到ID；21%人员框无ID（82%为置信度<0.5）。结论：不是帧率高或丢失保留太短（已按时间保留2秒、卡尔曼按时间推算），而是 ByteTrack 低分框接续要求 IoU≥0.5、新建要求≥0.6，中间形成空档；旧恢复用两点估速且对外ID直接借用 ByteTrack 内部编号，回放发现同帧编号重复（`Duplicate tracker identity`，旧代码在现网录制回放中72帧失败）。

**设计/实现**（`ai-service/src/analytics/bytetrack_adapter.hpp` 身份层 `Identify`）：
- 对外ID由身份层自有计数器分配，ByteTrack内部编号只作映射；同帧已用ID不再分配，结构上无重复。
- 每帧候选 = ByteTrack 新内部轨迹 + 其未匹配的检测（≥0.1）；只能接续**同类别**（类别即独立频道）、本帧未出现、丢失≤max_gap_seconds 的身份；低分框永不新建身份。
- 判定：按平滑速度（增益 dt/0.5s，速度上限3倍对角线/秒）外推的预测框；宽高比相差≤1.6倍、面积相差≤2.5倍，且 IoU≥0.3 或中心距离≤(0.6+0.6×min(丢失秒,1))×对角线；按代价一对一贪心。全部参数按秒，与帧率无关。ByteTrack 自身的首轮关联不加形状约束（鱼眼姿态变化大，加了会更碎）。
- 测试 `test/ai_port/bytetrack_recovery_test.cpp` 10例（原4例+惯导预测/低分接续不新建/形状门/类别隔离/5·10·15fps一致/200帧随机无重复），先红后绿。

**回放与守门**：`test/ai_port/tracking_replay.cpp`（注册于 test/bytetrack，离线回放检测结果）+ `test/ai_port/eval_replay.py`，数据在 `test/results/analytics/replay/`（输入仅含≥0.25的显示框，偏保守）。同输入对比旧代码（HEAD）：现网录制带ID占比 73.5%→82.0%、失败帧 72→0、轨迹中位长 65→73.5；楼梯视频 5fps/逐帧均 6人6ID、0断裂、0互换（守门通过），带ID占比 83.8%→87.8%、84.8%→93.7%。新代码剩余17次疑似断裂**全部是形状剧变**（面积比0.06–0.4或1.6–4.3），无门内漏接；是否同一人需看画面。

**现网复测**（部署后同通道再录3分钟，`live-gate-10fps-record-v2-identity.json`）：带ID占比 78.9%→83.4%，低分框得ID 705→1269，断裂 27→10，轨迹 152→139、中位长 64.5→73；通道 running、0错误、SEI与推理一一对应。部署前二进制备份 `deploy/s100p/rollback-ai-20261019-*`（取最新）。

**未提交**：`bytetrack_adapter.hpp`、`bytetrack_recovery_test.cpp`、`test/bytetrack/CMakeLists.txt`、新增 `tracking_replay.cpp`/`eval_replay.py`/`record_gate_results_v1.py`。工作区另有其他会话的 `alarm-service/` 与报警设计文档，不属本项。

### 4.9 短时丢失惯导补框与低置信显示（2026-10-19 晚，已上线，未提交）

**用户需求**：目标短时丢失（默认1秒，可设置）不要马上消失，按原运动方向推算补框。**现网数据**：同ID中断3分钟369次，83%≤1秒，占轨迹时长17.7%。

**实现**：
- 配置 `analytics.coast_seconds`（默认1，0–2，≤max_gap_seconds，0关闭）；向导“目标跟踪”步可设置，校验在 `validateVisibleAnalytics`。
- `tracker.hpp`：ByteTrack 路径也维护按源时间的 `MotionFilter`（卡尔曼），`PredictedBoxAt(id,pts)`。`frame_analytics.hpp`：丢失≤coast_seconds 的已确认目标输出 `predicted_bbox`（裁到画面内，出画即停）；`MarkHiddenObservations`：本帧只被低于显示阈值的跟踪候选接住的已确认目标标 `display_kind=low_confidence`（现网复测发现这类占缺框的约45%，单靠推算覆盖仅55%）。`CoastDetections` 生成仅供显示的框。
- SEI：推算框 `"pr":1`、低置信框 `"lc":1`，无置信度，排在真实框之后，预算不足先丢；**从不进入 result.detections**，所以归档、快照、统计、规则/告警都不受影响。
- 前端：`pr`/`lc` 解析；推算框与低置信框虚线，标签“#ID 推算”/“#ID 低置信”；轨迹中触及推算点的段为虚线（`trailSegments`）；诊断计数不含推算框。
- 测试：`test/ai_port/analytics_coast_test.cpp`（配置边界、沿运动推进、超时停止、0关闭、出画裁剪、不进检测、低置信、SEI标记与预算顺序）、`frontend/src/test/trackingCoast.test.ts`，均先红后绿；后端跟踪9项、前端955项通过（唯一失败为他人告警配置页“MongoDB 连接”文字）。
- 大门通道 SEI 上限 1024→2048（用户批准，热更新）。

**验证**：回放（只含≥0.25显示框）≤1秒中断缺帧推算覆盖98.6%，恢复时推算框与真实框 IoU 中位0.62；楼梯视频 ID 结果不变（0互换0断裂）。现网复测：≤1秒中断缺帧画面有框比例 55.2%（仅推算）→97.8%（推算511+低置信433，余21）；SEI 与推理一一对应、0错误。数据 `test/results/analytics/live-gate-10fps-record-v3-coast.json`、`v4-lowconf.json`。

**部署教训（重要）**：
- 主工作树含其他会话未提交改动，**不能在主树编译部署**。首次部署把告警会话的 `label_catalog`（每帧80类标签目录写进 model_extra）一并带上线，SEI 基础信封超1024字节，每帧“SEI 预算不足以容纳基础元数据”，事务脚本自动回滚。**提醒告警会话：label_catalog 不能进 SEI wire（应像 analytics 一样在 sei.cpp 擦除），否则上线即全量 SEI 失败。**
- 改用干净工作树 `/home/sunrise/ainvr-track-deploy`（HEAD + 本项文件 + worker 中本项两行）。cmake 必须带 `-DAINVR_LICENSE_SERVICE_USER=sunrise`（默认 ainvr 会导致许可校验失败、通道静默不启动，第二次部署因此回滚）。
- 回滚备份 `deploy/s100p/rollback-ai-20261019-*`（取最新）；前端旧 dist 在 `/home/sunrise/ainvr-merge-backup-20261019/`。

**未提交**：本项与 4.8 的跟踪文件（bytetrack_adapter/config/frame_analytics/tracker/sei.cpp/sei.hpp、worker 中 SEI 与 MarkHiddenObservations 两行、前端7个文件与2个测试、test/bytetrack/CMakeLists.txt、回放/录制工具）。worker.cpp 与告警会话共用，提交时需按代码块拆分。

### 4.10 轨迹滑动窗口修复（2026-10-19 晚，前端已上线，未提交）

**用户反馈**：轨迹约每2秒整条消失再重画；应随目标移动从尾部擦除、头部续接。
**原因（前端）**：① `AiDetectionOverlay` 只在当前显示帧匹配到 SEI 结果时才画轨迹（`showTrails && frame`），识别10fps/视频15fps，未匹配或沿用超300ms即整层不画；② `TrackTrailBuffer.update` 收到时间早于上一次的结果即全清，近似对齐每2秒（WebRTC getStats 轮询）重估延迟会产生小幅回退，触发整条清空。
**修复**：轨迹独立于当前帧，最近3秒内收到过识别结果就持续绘制（`TRAIL_IDLE_MS`），超过则视为停流不画；回退≤5秒视为对齐抖动丢弃该过时结果、轨迹保留，>5秒（回放拖动/重启）才清空；滑动窗口按最新时间逐点擦除（30秒/360点），会话变化、单目标>3秒未见、换通道仍清空。框仍只画当前帧结果。
**测试**：`frontend/src/test/trackTrailWindow.test.tsx`（小回退不清空、大回退/停顿清空、尾部单调滚动不坍缩、未匹配帧仍画轨迹、停流后不画），先红后绿；前端全量967通过（唯一失败为告警会话“MongoDB 连接”文字）。经干净工作树构建上线（旧 dist：`/home/sunrise/ainvr-merge-backup-20261019/frontend-dist-before-trailwindow`）。未做浏览器实看（需登录），对齐模式（精确/近似）未现场确认。

### 4.11 轨迹随目标存亡、只留最近5秒（2026-10-19 晚，前端已上线，未提交）

**用户反馈**：4.10 后走到另一个极端——轨迹全局保留，目标消失后轨迹还在。**原因**：缓存只按时间（30秒）淘汰点，不在结果里的目标不删，最多残留30秒。
**修复**（`trackTrails.ts`、`AiDetectionOverlay.tsx`）：每个目标只保留最近5秒（默认，120点够24次/秒）；新一帧结果里没有该目标（真实框、低置信框、推算框都没有）即整条擦除，目标回来重新起画；推算框期间轨迹保留（虚线），推算结束即擦除；超过1秒收不到任何结果（停流/AI停）不画轨迹（原3秒）。4.10 的抗对齐回退逻辑不变。
**测试**：`trackTrailWindow.test.tsx` 新增消失即擦除、推算期间保留，滚动窗口改为5秒；`trackTrails.test.ts` 默认窗口/会话/上限三例按新语义调整；先红后绿，前端全量968通过（唯一失败为告警会话"MongoDB 连接"文字）。干净工作树构建上线（`index-B1FTjHsu.js`，旧 dist：`/home/sunrise/ainvr-merge-backup-20261019/frontend-dist-before-trail5s`），同时带上 e8f5555 中的向导文字修正。未做浏览器实看。

## 5. 第一阶段完成标准

- 跟踪开关保存、刷新、重启后的配置一致；旧通道默认行为不被擅自改变。
- 可见目标产生真实身份，轨迹来自实际观测；ID不跨新视频会话误连，长时间丢失不会无限拖尾。
- 轨迹开关立即显示/隐藏，操作不重启AI、不改后端配置；跟踪未开启时有清楚提示。
- 检测框与轨迹在同一播放帧对齐，缩放/黑边/延迟流均正确；换通道/重连/时间跳变清空旧缓存。
- 多播放器不串轨，点数/目标数/SEI/内存有界；长时间运行不持续增长。
- 有分数和无分数模型能力清楚，低频限制如实显示；不承诺跨摄像头ReID、物理速度、行为判断或报警。
- 额外功能UI和后台均已屏蔽并验证，已有用户数据保留。
- 最终构建、部署、原业务回归和实际浏览器验收均有证据。单测通过或截图存在不足以证明完整完成。

## 6. 已有实验及复用资料

根目录 `/home/sunrise/ainvr`，报告在 `test/results/analytics/`：
- vpu-20261019-110028/summary.json：499帧硬件VPU，像素MAE0，PTS舍入差<=500ns。
- corridor-bpu-tracking-full-v2.json：stride5；corridor-bpu-tracking-full-stride1-v3.json：逐帧；用于检查ID/轨迹，不能只看事件总数。
- corridor-bpu-line70-stride5-v4.json、corridor-line-position-comparison.json：用户要求把线右移至70%的历史测试，保留但不继续作为当前功能开发项。生产规则未改。
- sampling-guidance-ui.log、sampling-guidance-build.log：47项向导/编辑测试和前端构建历史通过；需对新屏蔽改动重新做相关验证。

原视频只读：`D:\code\LocateAnything-3B\193-0720\问题视频\subtest_16-43_clip_2m40s-3m00s.mp4`。
SSD数据：`/mnt/ainvr-ssd/analytics-validation/`，完整NV12在 vpu-20261019-110028/ 子目录。
核心探针 test/ai_port/corridor_analytics_probe.cpp、vpu_poc_probe.cpp；复现脚本见test/results/analytics/build_corridor_probe.py、verify_corridor_vpu_full.py。
历史失败测试保留；不通过删失败报告或改预期制造通过。

## 7. 环境与源码入口

- SSH root@192.168.100.189；RDK S100P；项目 `/home/sunrise/ainvr`；生产AI服务身份sunrise。
- 本机staging `D:\codex-task-staging\ainvr-analytics`；D:\code\kakadeai不是开发目标。
- 分支main，最近核对HEAD c769bd757e740a6fa7cc77b2ca6e604805a2e950；有大量未提交修改，继续前看git status，禁止覆盖。
- 后端 ai-service/src/analytics/{tracker,motion_filter,bytetrack_adapter,candidate_results,frame_analytics,config}.hpp；pipeline/reused_channel_worker.cpp/.hpp；stream/sei.cpp；output/；api/control_server.cpp/.hpp。
- 前端 srs-web-console/frontend/src/pages/AiChannels/AiChannelWizard.tsx；components/player/trackTrails.ts；相关test文件。额外组件保留源码但按第4节停用。
- 服务构建 `cmake --build out/build/ai-s100p --target ainvr_s100p_control_service -j2`；近期库更新不代表最终服务二进制已更新。
- 测试工程 test/results/analytics/build、test/results/analytics/bytetrack-build；构建后ctest --output-on-failure。
- 前端按package.json执行针对测试和npm run build。
- 事务安装入口 deploy-package/install-ai-s100p.py，先读当前脚本和回滚要求。本阶段实际部署用的是“停 ainvr-ai → 原子替换 deploy/s100p/bin/ainvr_ai_service → 启动 → 等通道 running 且 SEI 注入 → 失败自动换回”的脚本；部署前二进制备份在 `deploy/s100p/rollback-ai-20261019-*`（按时间取最新一份回滚），前端旧 dist 备份在 `/home/sunrise/ainvr-merge-backup-20261019/`。
- Mongo localhost:27017，数据库ainvr_snapshots，隔离测试test_analytics_events；凭据仅内存读取，不写文档/命令行。
- 页面 http://192.168.100.189:8088/ai-channels；CUA曾初始化失败。独立Chrome profile为D:\codex-task-staging\ainvr-analytics\browser-review-20261019，端口重新读DevToolsActivePort；helper inspect-review-browser.mjs。最后验收仍停登录，不能宣称页面通过。

## 8. 工作纪律与文档优先级

本文件当前正文优先于旧版长期设计范围。docs/AI-TRACKING-IMPLEMENTATION.md保留历史事实；UX-ACCEPTANCE和ALGORITHM-AND-STORAGE中的未来规则/存储/告警设计仅作参考，不能自动恢复为当前待办。

只修改远程AINVR，TecheAI和子模块只读；大文件放SSD。修改前后核对hash，保留并发修改。用户允许有界暂停AI实验但必须finally恢复，录像不能停。不删除历史代码/数据、不自动提交推送。

当前下一步：见第3节。门控、轨迹中心锚点/30秒历史、会话清空、断裂修复均已上线；浏览器验收未做；提交待用户指示。

<!--
以下为历史版本，非当前任务范围或待办：
# AINVR 跟踪器开发交接

更新：2026-10-19。按用户最新决定调整范围；本节是当前执行依据。旧版交接保留在文件末尾的 HTML 注释中，仅供追溯，不作为当前待办或验收要求。

## 1. 当前目标与阶段顺序

当前专门开发跟踪器：在现有 AI 微服务内完成检测结果关联、目标 ID、轨迹显示及运动估计，做好后续行为判断的数据基础，并完成测试、部署和真实浏览器验收。

业务推进顺序：
1. 检测 → 跟踪 → 显示轨迹。
2. 运动估计，处理短时遮挡、漏检和轨迹中断。
3. 在此基础上逐步实现出现、接近、接触/碰撞、进入、穿越等行为判断及流量统计。
4. 后续开发布防、告警条件及告警决策。
5. **决定发告警时，才将图像和告警信息送给 VLM 复核，再按复核策略决定是否发送通知。**

当前不开发、不调试、不上线大模型复核和报警通知。它们不属于本阶段验收，不得继续因复核误报或模型调度问题阻塞跟踪器上线。未来行为判断也必须逐项设计和验证，不把未来全部告警能力捆绑为当前跟踪器完成条件。

已有基础越线/区域/停留规则代码可保留作跟踪验证与后续基础；不能宣称所有行为类型已经完成。

## 2. 本阶段必须交付

- 跟踪、运动估计作为 AI 微服务内的独立模块，接收统一检测结果。
- 有分数模型采用已接入的 ByteTrack；无分数模型走明确标识的运动关联，不伪造置信度。
- 目标 ID、会话 ID、类别、观测位置、源视频时间、运动状态形成统一输出，接入现有 SEI。
- 短时丢失采用卡尔曼等运动预测帮助关联；区分观测与预测，超时终止轨迹，不无限补线。
- UI 可配置开启/关闭跟踪，说明算法兼容性、采样限制；实时预览可单独切换轨迹显示。
- 明确实时内存缓存与保存策略，轨迹有界；不因浏览器打开/关闭改变服务端跟踪行为。
- 完成真实视频验证、必要回归、服务及前端部署、实际浏览器操作验收；恢复测试前用户配置。

## 3. 已完成与未完成

| 项目 | 已有成果 | 当前仍需完成 |
|---|---|---|
| 有分数跟踪 | ByteTrack适配、单测、真实BPU视频运行 | 逐人身份与轨迹人工核对、遮挡往返验收 |
| 无分数跟踪 | 运动关联与Kalman MotionFilter接线 | 实际低频输入下连续性、失踪/重现边界验证 |
| 帧与身份协议 | 源PTS、会话重置、观测时间、预测区分 | 断流、换模型、乱序/长间隔、回放验证 |
| 轨迹显示 | SEI接线、浏览器缓存和开关代码及测试 | 真正播放延迟视频、多窗口、换流、长时间验证 |
| 跟踪设置 | 向导、采样说明、相关测试 | 页面保存/回显、取消/错误、兼容性实测 |
| 基础空间规则 | 越线/区域/停留模块与实验 | 作为跟踪效果验证，后续行为能力单独验收 |
| 存储 | 已有事件/归档相关实现 | 核对本阶段轨迹保存能力及UI，未实现策略不展示为可用 |
| 上线 | 前端构建与部分库测试通过 | 最终服务构建、事务部署、原通道回归、真实浏览器验收 |

整体未完成，不把现有生产页面正常运行当作新跟踪功能已经上线。

## 4. 测试证据及用户最新画线要求

以下相对路径以 `/home/sunrise/ainvr` 为根。

- `test/results/analytics/vpu-20261019-110028/summary.json`：真实VPU完整499帧，像素MAE 0，PTS舍入差不超过500ns。
- `corridor-bpu-tracking-full-v2.json`：stride5约5fps，中央线5次事件。
- `corridor-bpu-tracking-full-stride1-v3.json`：每帧处理，中央线6次事件。
- `corridor-bpu-line70-stride5-v4.json`：约5fps，线位于横向70%，6次事件。
- `corridor-line-position-comparison.json`：框、类别、分数和PTS一致，只有线位置变化。
- `corridor-sampling-comparison.json`：采样比较。
- `sampling-guidance-ui.log`：47个向导/规则编辑测试通过。
- `sampling-guidance-build.log`：前端构建通过，未据此宣称部署完成。
以上简写报告均在 `test/results/analytics/`。

用户要求：计数线从画宽50%向右移动20%至70%，靠楼梯、人体更完整处。当前仅测试采用，生产配置未改。测试线纵向25%–90%，锚点为真实观测框底部中心。右移使ID9在轨迹碎裂前完成穿越；不是模型精度提升，也不是完整标注后的100%计数准确率。

原视频只读：`D:\code\LocateAnything-3B\193-0720\问题视频\subtest_16-43_clip_2m40s-3m00s.mp4`。
SSD素材：`/mnt/ainvr-ssd/analytics-validation/`。499帧原始NV12在其 `vpu-20261019-110028/` 子目录，大文件不复制到C盘。

## 5. 接手后直接按此顺序继续

1. 读取当前工作区和本交接；不要继续前次VLM tensor导出、负样本误报或共享模型调度排查。
2. 核对真实视频的ID、漏跟踪、ID切换、观测/预测状态，给出逐人标注；扩大遮挡、往返、静止、出入画、低频及断流场景。
3. 检查统一输出和SEI：源PTS对齐，完整会话身份，预测不能冒充真实观测；旧识别与归档兼容。
4. 核对跟踪UI与实时预览体验，隐藏或禁用未完成/本阶段不开放的复核与通知入口，不删除历史代码。
5. 明确当前可用轨迹存储策略；只开放已验证功能，保留后续扩展接口。
6. 完成针对回归和最终构建，事务部署；验证原通道、录像、推流、归档不回归。
7. 实际浏览器操作跟踪开关、保存刷新、模型切换、轨迹显示、多窗口和换流，记录证据并恢复用户配置。
8. 更新本阶段验收结论。后续行为判断和告警/VLM复核另行推进。

## 6. 验收中的隐含约束

- SRS通道仍只在接入管理配置；AI仅选已有输入输出。
- 开启跟踪是服务配置；显示轨迹是浏览器偏好；保存轨迹是独立存储策略。
- 预测用于补偿关联，不制造真实检测、越线或进入证据；首次见到目标已在区域内，不补造进入。
- ID只承诺单摄像头会话内，换流/重启不冒充同一个人；不承诺跨摄像头ReID。
- 按播放帧PTS显示轨迹，不能拿最新处理结果覆盖延迟画面；跳转和重连清理旧轨迹。
- 未标定速度只用像素/秒；二维重叠不能宣称物理碰撞。
- 低采样率存在漏跟踪风险，必须说明实际处理能力；缓存、轨迹点数和SEI均有界。
- 生产录像保持；有界暂停AI做硬件测试需finally恢复。无真实外部通知、无自动提交推送。
- 完成必须有部署和页面证据，不能只凭单元测试通过。

## 7. 环境、源码与命令

远程：root@192.168.100.189，RDK S100P，仓库 `/home/sunrise/ainvr`。生产AI身份sunrise。
本机staging：`D:\codex-task-staging\ainvr-analytics`；当前cwd `D:\code\kakadeai` 不是开发目标。TecheAI/子模块只读。
分支main，交接核对时HEAD c769bd757e740a6fa7cc77b2ca6e604805a2e950；大量未提交修改，必须保留，提交号不能代表当前源码。

核心：`ai-service/src/analytics/` 的 tracker.hpp、motion_filter.hpp、bytetrack_adapter.hpp、candidate_results.hpp、frame_analytics.hpp、geometry.hpp、config.hpp。
接线：pipeline/reused_channel_worker.cpp/.hpp、stream/sei.cpp、output/、config/、api/control_server.cpp/.hpp。
前端：`srs-web-console/frontend/src/pages/AiChannels/`、`src/components/player/trackTrails.ts`及相关test。
探针：`test/ai_port/corridor_analytics_probe.cpp`、vpu_poc_probe.cpp、analytics_*、bytetrack_*。
复现：`test/results/analytics/build_corridor_probe.py`、verify_corridor_vpu_full.py、compare_corridor_sampling.py。

最终服务：`cmake --build out/build/ai-s100p --target ainvr_s100p_control_service -j2`。
测试：`test/results/analytics/build`、`test/results/analytics/bytetrack-build`，构建后ctest --output-on-failure。
前端：srs-web-console/frontend 内按package.json运行针对测试及npm run build。
安装：`deploy-package/install-ai-s100p.py`，执行前读当前事务部署与回滚流程，不假设库更新等于服务二进制更新。

页面：http://192.168.100.189:8088/ai-channels。
CUA曾报kernel assets路径不存在。独立Chrome profile：`D:\codex-task-staging\ainvr-analytics\browser-review-20261019`，端口重读DevToolsActivePort，helper为inspect-review-browser.mjs。最后检查仍为登录页，未做功能页面验收。不存密码、不绕过鉴权。

Mongo localhost:27017，ainvr_snapshots；隔离测试集合test_analytics_events。凭据只从既有secret在内存读取，不写交接或命令行。

## 8. 历史文档与延期内容处理

保留 `docs/AI-TRACKING-IMPLEMENTATION.md` 的历史证据，以及 `docs/AI-TRACKING-UX-ACCEPTANCE.md`、`docs/AI-TRACKING-ALGORITHM-AND-STORAGE.md` 的长期设计。
这些文档中VLM/通知相关条目属于后续阶段，不作为当前验收门槛。UX矩阵中U14/U15延期，其余条目按当前跟踪范围拆分验收，超出范围部分标后续，而非标已完成。

已有复核测试失败、调度限制和代码保留供后续告警阶段接手；本次只调整文档与任务范围，不删除实现、不修改运行服务。

### 2026-10-19 下午补充（LocateAnything 多类别会话）

- **现网已含追踪代码**：13:00 前后为上线 LocateAnything 多类别，主工作树（含本任务未提交改动）整体编译并事务部署了 `ainvr_s100p_control_service` 和前端 dist；备份 `deploy/s100p/rollback-ai-20261019-*`、合并前文件 `/home/sunrise/ainvr-merge-backup-20261019`。各通道均未开启跟踪；“新功能未部署”的说法已不准确，但跟踪功能仍未做页面验收。
- **复核误报已查明原因（暂缓，不继续）**：LocateAnything 一直把原样描述直接发给模型；官方用法是 `Locate all the instances that matches the following description: <描述>.`。原样描述时模型会去框 OSD 文字（无人图的两个框就是左下“IPC”标志和右上时间戳），Pillow 离线参考输入同样复现，与 JPU/GLES 预处理无关；BF16 原版加模板为 None。证据 `test/results/analytics/review-oracle-v1/`、`test/results/locateanything-prompt-template-probe-v328.json`（32张COCO真值：召回 0.348 不变，精确率 0.369→0.435，非查询名下的框 30→0）。
- 按用户决定（本阶段与 LocateAnything 无关），提示词模板、执行器排队和复核共享执行器的源码改动**均已撤回**，相关文件与改动前逐字节一致，排队头文件和测试已删除；只保留上面的实验证据，供将来告警/复核阶段参考。

【历史注释开始】
以下为范围调整前的历史交接，仅供追溯。原待办/验收范围已被以上用户最新决定替代。
# AINVR 跟踪、规则、异步复核交接

更新日期：2026-10-19（北京时间）。本文是继续工作的入口，不是完成验收报告。

## 1. 结论：当前做到哪里

整体目标未完成。已经有模块实现、单元测试、真实视频硬件跟踪实验和真实图片异步复核实验；新的完整功能尚未部署并完成浏览器验收。不可把当前网页运行正常、前端构建成功或测试脚本存在当作新功能上线。

最新实质问题：异步复核实际走通了 Mongo 证据 → JPU/GLES → BPU → Mongo 结果，但无人图片被模型判为有人。必须先核对输入图像和生成结果，再判断是预处理问题还是模型误报。另一个独立问题是现有 LocateAnything 通道长期持有独占锁，复核不能与其共享运行资源。

远程当前分支 main，HEAD c769bd757e740a6fa7cc77b2ca6e604805a2e950；存在大量本任务及其他未提交修改。此提交号不能代表当前构建源码，继续前必须看工作区，不要 reset/checkout 覆盖。未提交、未推送。

## 2. 用户目标及不可缩减的要求

- 当前 AI 微服务内部增加独立跟踪、运动估计、基础空间规则模块；不是另建一套检测微服务。
- 统一适配不同检测器输出，保持模型自己的输入尺寸和后处理；有分数与无分数模型不能伪造同一种能力。
- 支持稳定目标 ID、短时遮挡运动预测、轨迹，作为后续流量统计和区域布防基础。
- 大模型复核和报警通知异步处理，不阻塞视频流水线。
- UI 具有开关、兼容性提示、画线/区域编辑、真实视频参考画面、预览轨迹开关、事件查询及处置状态。
- 不只写代码：需要测试、部署、实际浏览器操作和页面检查。
- 接入管理独占 SRS 通道创建/配置入口。AI 处理器只能选已有输入 SRS 和输出 SRS。
- 保留用户现有配置、录像和数据；不自动发送外部通知，不自动提交或推送。

### 行为语义，避免隐藏误判

用户最终需要出现、接近、接触/碰撞、进入、穿过及流量统计。当前基础不能被描述成这些全都实现了。

穿越发生不代表所有前置阶段都被摄像机观测到。首次看到目标已在区域内，不补造进入；漏帧后出现在线另一侧，不无限期补造穿越。卡尔曼预测用于关联和短期估计，不构成真实检测证据。

“碰撞”必须先明确业务含义：二维框/区域相交只可称接触或重叠，不能直接宣称物理碰撞；真实危险碰撞通常还需时间、距离/标定或其他证据。当前单帧 VLM 只复核目标存在，不能证明越线、停留、接近或碰撞发生。

## 3. 实现状态与证据分级

| 项目 | 当前状态 | 尚缺的完成证据 |
|---|---|---|
| ByteTrack 有分数检测关联 | 已有适配与测试，真实 BPU 视频已运行 | 逐人逐事件标注、遮挡/往返综合验收 |
| 无分数模型跟踪 | 独立运动关联，已接入 Kalman MotionFilter | 完整实时场景验收；不能叫作具有低分候选能力的 ByteTrack |
| 源时间与会话身份 | 已实现源 PTS、会话重置、观测时间与预测区分 | 真实断流/回放/改规则验收 |
| 越线、区域和停留基础规则 | 模块和测试存在 | 完整业务规则控件、人工标注与页面验收 |
| SEI 轨迹及浏览器开关 | 有实现和测试 | 实际延迟视频、多窗口、回放跳转及长时间运行 |
| Mongo 事件与异步待办 | 有持久化、租约、去重、状态与测试 | 故障恢复端到端验收及完整查询体验 |
| VLM 复核 | 真实硬件链路执行成功，但语义验收失败 | 无人误报定位、共享资源调度、正负样本扩展 |
| 通知 | 有 webhook 与策略实现、测试证据 | 完整 UI/恢复/幂等验收；没有发真实外部通知 |
| UI | 向导、规则编辑、复核/通知设置、事件页有代码 | U01–U20 逐项实际浏览器验收，不能全标完成 |
| 全量轨迹存储/统计/事件详情 | 产品方案已有，不能认定完整实现 | 分段存储、保留策略、分页筛选、关联录像等逐项核对实现 |
| 部署 | 新功能未完成部署 | 最终服务构建、事务部署、旧通道回归、浏览器证据 |

设计文档比实现范围大；所有设计条目都要逐项验证，不能因为写在文档里就认为已开发。

## 4. 最近的真实测试结果

全部相对路径以下均以 /home/sunrise/ainvr 为根。

### 4.1 楼梯视频、硬件解码与跟踪

原视频（本机只读）：
`D:\code\LocateAnything-3B\193-0720\问题视频\subtest_16-43_clip_2m40s-3m00s.mp4`

原文件 SHA256：788ee5c16e9890b2bc786506566197dd220af067480ee311d50507d59664c461。
容器帧数与实际解码数有差异，实际499帧。离线生成 H264 测试副本仅用于硬件测试，原始视频不变。

SSD：`/mnt/ainvr-ssd/analytics-validation/`
- corridor-20s-788ee5c1.mp4：原始副本。
- corridor-20s-h264-v1.mp4：H264 副本，SHA c48fc7be97b7890a05fe727bbcdf5658f9f0e62e660b7f22656992996c1d1c39。
- vpu-20261019-110028/hardware.nv12、reference.nv12：完整499帧，单文件约1.55GB。

证据：
- `test/results/analytics/vpu-20261019-110028/summary.json`：完整499帧 VPU，像素 MAE 0，PTS 小数舍入差最多500ns。
- `test/results/analytics/vpu-20261019-104625/`：早期失败保留；当时旧探针混用了系统 FFmpeg 库与8.1头文件，后续改用匹配8.1.2链接。不要误认为模型失败。
- `corridor-bpu-tracking-full-v2.json`：stride5，约5fps，中央线5次事件。
- `corridor-bpu-tracking-full-stride1-v3.json`：每帧，中央线6次事件。
- `corridor-bpu-line70-stride5-v4.json`：约5fps，线右移至宽度70%，6次事件。
- `corridor-line-position-comparison.json`：两种线位置的框、类别、分数、PTS完全一致，仅规则位置变化。
- `corridor-sampling-comparison.json`：采样差异检查。
以上未带前缀的报告均在 `test/results/analytics/`。

用户最新要求已在测试采用：线从50%右移20%画宽到70%，纵向25%–90%，以观测框底部中心为锚点。这样 ID9 在碎裂前完成穿越，补到了中央线漏掉的一次。**仅测试，生产规则未改；不是模型精度提升，也不是已证明6/6准确率。** 完整人工身份标注尚缺。

测试检测器 YOLO26x HBM SHA：65e2cd362771a616c39a5d55b5fd520cb8a0f78112bd389a284179effd75948d。
可见检测阈值0.25，跟踪候选0.1；不能为了 ByteTrack 把所有低分框也作为正常识别归档。

### 4.2 真实异步复核：明确未通过

程序：`test/ai_port/analytics_neural_review_probe.cpp`。
最终本轮结果：`test/results/analytics/neural-review-20261019-112623/result.json`；同目录 execution.json、probe.log。

| 图片 | 预期 | 实际 | 单次模型推理耗时 |
|---|---|---|---|
| review-empty.jpg，无人楼梯 | rejected | approved，2框 | 21337.08ms |
| review-person.jpg，有人 | approved | approved，4框 | 4724.88ms |

这不是稳态测速；不能用第二张或两张平均值代表产品吞吐。
图片在 SSD analytics-validation 下。本机 staging 有对应图片，已目视确认 empty 无可见人员。
- empty SHA：22b9c7837a929603f8a261a62a3a0e6ac6748f8a3eb0febdb10ce51f33531157
- person SHA：6a7b029dc90b526a587b428892a99698fe8dca82a14aa83b3232b6aa1b9cfe49

初次 root 执行被锁文件身份保护拒绝：112349报告和112536日志保留。生产服务 User/Group=sunrise，锁属 sunrise，0600；后续用 runuser -u sunrise 执行。不得 chmod 放宽或绕过锁。

测试创建唯一隔离 channel 和对应 snapshots 集合；退出清理自己的证据集合，test_analytics_events 中结果保留。没有真实通知。测试有界停止 ainvr-ai 后在 Python finally 恢复，未停录像；最后检查 ai/recorder/官方模型服务均 active。但 active 本身不是完整用户通道恢复验收。

## 5. 下一步优先顺序（接手可直接开始）

1. **先排查复核输入**：目前中断点是已读 analytics_review_image_probe.cpp、review_image.hpp 和 locateanything_pillow_preprocess.hpp，还没有编写新的 tensor 导出探针，没有后台编译/测试在运行。
2. 给测试探针增加独立输出，导出真实 JPU/GLES 最终 3×224×448 tensor；只改测试，不先改生产算法。将无人/有人两张图片与明确标注为离线 oracle 的 Pillow 参考比较，并还原可视图，检查颜色范围、通道、裁剪和缩放。现有探针只检查 finite/shape，不证明图像正确。
3. 保留所有失败记录；复核结果补充测试级生成 token/框位置证据，确认误报具体落点。不要为了通过测试更换负样本、吞掉错误或硬编码无人图。
4. 输入一致后仍误报，评估提示词/模型能力及更完整正负样本；必要时明确模型复核限制，不能宣称可靠降误报。
5. 解决并发调度：现有生产 LocateAnything adapter 生命周期持有锁，复核加载会返回 model_in_use。不能把这种永久不可用当作已实现异步复核。设计共享常驻执行器的有界串行队列、公平性、超时和取消；不绕过锁直接并发生成。
6. 完成人工视频计数/ID标注及遮挡往返用例；保持中央线与70%线历史对比。
7. 对照 UX 文档补齐未实现控件/历史/存储，执行回归和完整构建。
8. 事务部署新服务与前端，验证原通道，再完成 U01–U20 实际页面操作。测试配置恢复、临时数据隔离、截图/日志留证。
9. 完成条件全部满足后更新交接/验收文档；未满足不得标整个目标完成。

## 6. 主要源码与测试入口

后端 `ai-service/src/analytics/`：
- tracker.hpp、motion_filter.hpp、assignment.hpp、score_association.hpp：身份关联与运动估计。
- bytetrack_adapter.hpp、candidate_results.hpp：有分数检测器接入。
- frame_analytics.hpp、geometry.hpp、config.hpp：帧级规则与参数。
- event_store.cpp/.hpp、event_outbox.hpp、event_worker.hpp、event_evidence.hpp：异步持久化、证据与租约。
- locate_review.hpp：目标存在复核；明确 temporal_rule_verified=false。
- review_image.hpp：JPEG → JPU → GLES → Pillow兼容GPU缩放。
- webhook_notifier.hpp：通知。

接线：`ai-service/src/pipeline/reused_channel_worker.cpp/.hpp`、`api/control_server.cpp/.hpp`、`config/`、`stream/sei.cpp`、`output/` 的归档编解码和截图链路。

前端 `srs-web-console/frontend/src/`：
- pages/AiChannels/AiChannelWizard.tsx：四步向导，采样限制说明。
- AnalyticsRuleEditor.tsx、AnalyticsReviewSettings.tsx、AnalyticsNotificationSettings.tsx、AnalyticsEvents.tsx 位于同目录。
- components/player/trackTrails.ts：轨迹缓存。
- features/analyticsRules.ts、analyticsNotification.ts。
- test/Analytics*.test.tsx、analytics*.test.ts、trackTrails.test.ts、AiChannelWizard.test.tsx。

硬件测试：`test/ai_port/analytics_*`、`bytetrack_*`、corridor_analytics_probe.cpp、vpu_poc_probe.cpp。
基础测试工程：`test/analytics/`、`test/bytetrack/`。
复现实验脚本：`test/results/analytics/verify_corridor_vpu_full.py`、verify_corridor_vpu_ffmpeg8.py、build_corridor_probe.py、compare_corridor_sampling.py。
注意部分脚本仍在 results 下，值得后续整理进稳定测试目录，整理前保留路径映射，不删除历史。

## 7. 调试环境、构建与运行

- 开发板 RDK S100P，SSH root@192.168.100.189，项目 `/home/sunrise/ainvr`；生产服务身份 sunrise。
- 本机当前工作目录 D:\code\kakadeai 不是本任务开发目录。
- 本机仅 staging：`D:\codex-task-staging\ainvr-analytics`；其他项目、TecheAI与子模块只读。
- 大文件放 `/mnt/ainvr-ssd`，不要恢复过去往 C盘 Docker /opt 堆巨大中间产物的做法。
- 库/服务构建目录 `out/build/ai-s100p`。近期只更新过部分库，最终服务二进制不能假设已最新。
- 最终服务构建：`cmake --build out/build/ai-s100p --target ainvr_s100p_control_service -j2`。
- 基础测试目录 `test/results/analytics/build`、ByteTrack测试 `test/results/analytics/bytetrack-build`；各自 build 后 ctest --output-on-failure。
- 前端目录 srs-web-console/frontend；按 package.json 运行针对测试和 npm run build。
- 最近47个向导/规则编辑测试通过和前端构建通过：sampling-guidance-ui.log、sampling-guidance-build.log。不是全部产品验收。
- 安装入口 deploy-package/install-ai-s100p.py，支持 --binary 和 --start，先读当前脚本和事务回滚约束再执行；本轮未执行。

官方BPU常驻服务：ainvr-locateanything-official-bpu.service。
当前已观察执行器：ai-service/runtime/locateanything_bpu_text_gptq8_o2_eval_executor_v14.py。
契约：`/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1/official-full-family-w8a16-text-gptq8-o2-eval-v320.json`。
契约 SHA：a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381。
Socket：`/home/sunrise/ainvr/data/ai/locateanything-official-bpu.sock`。
模型锁：`/home/sunrise/ainvr/data/ai/locateanything-channel.lock`。
继续时重查 systemctl 和契约，路径版本名不是实时状态证明。不要重启正在正常工作的模型后端来碰运气。

Mongo localhost:27017，数据库/authSource ainvr_snapshots，测试事件集合 test_analytics_events。密码只允许从既有 secret 文件在进程内读取，通过 stdin 交给测试，不打印、不复制到脚本、命令行、环境或文档。本文不含凭据。

## 8. 浏览器环境与缺口

URL：http://192.168.100.189:8088/ai-channels。
CUA 初始化报 kernel assets 路径不存在，不能把它描述为页面通过。
已有独立 Chrome 调试 profile：`D:\codex-task-staging\ainvr-analytics\browser-review-20261019`。
端口从该目录 DevToolsActivePort 读取，不能沿用旧PID/端口当作还在运行。
本机 helper：inspect-review-browser.mjs；Node `C:\Program Files\nodejs\node.exe`。
最后已检查 DOM 为访问密码登录页，新功能尚无真实页面验收。登录只使用授权方式、临时内存输入，不修改或关闭鉴权来省事，不保存凭据。

## 9. 完成与隐含验收条件

完整验收矩阵以 `docs/AI-TRACKING-UX-ACCEPTANCE.md` 的 U01–U20 为准，每项必须有实际证据和结论。至少覆盖：

- 旧通道无行为回归；没有在AI界面偷偷新增SRS。
- 跟踪开启/关闭/重开、模型切换兼容、配置保存刷新一致。
- 原始帧归一化坐标；背景不可用不拿空白图假装完成画区；黑边不能混入坐标。
- 往返方向计数、线边抖动不重复、首次区域内不伪造进入、停留不重复。
- 真实源PTS而非处理完成时间；长丢帧/重连/换模型重置；ID与会话一起解释。
- 显示轨迹是浏览器偏好，不触发服务重启；保存轨迹是独立服务端策略。
- 轨迹跟正在播放的视频一致；换流、回放跳转清理；内存与SEI有界。
- 未标定速度只允许像素/秒，不显示物理速度；预测不能标为观测。
- 事件、图片、轨迹、录像来源准确关联；旧数据兼容；Mongo故障不阻塞推理，恢复无重复。
- VLM通过/否决/失败/超时/不可用明确区分；失败不能当作通过；原始规则事实不因否决删除。
- 通知显式配置才发送；有租约、超时、重试与幂等策略；不承诺任意外部接收端严格exactly-once。
- 编辑取消、保存失败、并发修改、键盘/移动端、长时间运行和TTL均验收。
- 部署后实测现有输入/输出、SEI、归档、录像和服务恢复；保留回滚路径。

## 10. 其他交接文档与工作纪律

先读：docs/AI-TRACKING-IMPLEMENTATION.md（按最新追加记录解释旧段落）、docs/AI-TRACKING-UX-ACCEPTANCE.md、docs/AI-TRACKING-ALGORITHM-AND-STORAGE.md、根AGENTS.md。

远程非平凡修改：记录SHA → 下载staging → 编辑UTF8/LF → 上传临时文件 → 重查SHA防并发覆盖 → 原子替换。不要因为本任务文件未跟踪就删除。

用户允许有界暂停AI做硬件实验，必须finally恢复；不停止录像。不得把此授权扩展到无界停机。此前其他历史任务的部署、重启或清理授权不构成现在随意改系统的许可。

本次交接整理期间仅做只读核查和文档写入，没有新启硬件测试、没有修改生产配置。整体工作保持未完成状态。
【历史注释结束】

-->

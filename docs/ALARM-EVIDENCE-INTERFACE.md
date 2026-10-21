# 原帧证据查询与界面

2026-10-19，源码和隔离测试已实现；尚未部署真实通道。AI 提供识别历史中的原帧目标裁剪；告警服务已实现可选独立复制保留，见 ALARM-EVIDENCE-RETENTION.md。独立保存功能尚未现网启用。

## 来源与不变量

AI 归档入口 OfferResult 给具有跟踪 ID 的检测冻结 observation_source：schema_version、stream_session_id、source_pts_ns、source_frame_index、frame_width、frame_height。PTS 与帧号是十进制字符串，现有 BSON frame_pts_ns 仍为 int64。修改的是归档副本，不改动模型输出或 SEI。

查找必须同时匹配 channel_id、track_id、视频会话、精确 PTS、原帧编号和归档 schema。没有“取最近时间图片”的回退。旧记录缺身份不推测；查询到两条冲突匹配返回 ambiguous_frame。track_id 是不透明标识，不从其文本结构猜测会话。

AI 证据模块只提供通用查询，不包含告警规则。索引为 track_id + frame_pts_ns，查询上限两条、maxTimeMS 2000。部署时需验证新索引在真实归档规模下的建立耗时和权限。

## 服务接口

AI 已鉴权 GET `/api/v1/channels/:id/observation-evidence`，参数为 stream_session_id、source_pts_ns、source_frame_index、track_id。命中返回 target_crop 引用、尺寸、可用版本及对应身份；无法匹配返回 unavailable 与原因。图片仍由原有 snapshots/:imageId/image 读取。

Web 后端新增：

- GET `/api/alarms/behavior-events/:eventId/evidence`
- GET `/api/alarms/behavior-events/:eventId/evidence/image?variant=processed|original`

前端只提交不可变行为 ID。BFF 先从告警服务读事实及独立保留状态。已保存时从告警服务读独立副本；未配置或旧记录未入队时，才用事实里的原帧身份向配置中的 AI 服务核对。已入队但未取得、过期或文件缺失时，不回退为其他图。原始流地址、服务凭据、任意目标 URL 均不下发浏览器；客户端不能指定 image_id 替换目标。图像读取前再次核对匹配，限定 JPEG 类型和 8 MiB 上限，响应 private/no-store。

来源编号缺失返回 frame_identity_unavailable；图片已清理或未保存返回 unavailable/404；服务或身份核对失败不返回未经确认的图片。告警事实新增可选 source_frame_index 字符串，旧事实仍可查询但无法声称拥有精确帧证据。

## 界面

行为记录详情可显示对应原帧裁剪；活动告警时间线通过每阶段 behavior_event_ids 打开该阶段截图，不使用告警当前最新帧代替较早阶段。支持处理后与原始裁剪切换、失败重试，并在卸载时释放浏览器对象 URL。

界面明确标注是目标裁剪、不是完整画面。旧记录或未独立保存时明确 pinned=false、retention=ai_history，仍受识别历史滚动清理。独立保存成功为 pinned=true、retention=alarm，显示期限；容量策略可能提前清理。等待、暂停、到期和缺失均显示明确状态，不能宣称永久存在。

## 验证与剩余工作

- 原生 probe 在隔离真实 Mongo 验证精确身份、超过 JS 安全整数的 PTS/帧号、错会话/错目标/错帧拒绝、重复归档拒绝及非法 UTF-8 拒绝。
- Snapshot pipeline/repository/store 和 control API 翻译单元语法检查通过。
- BFF 4 项测试覆盖绑定、鉴权、失效图片、原始版本、凭据不泄露；相关前端 10 项通过，包含阶段行为 ID 选择、对象 URL 释放、缺原帧身份不加载图片。前后端类型检查通过。
- 告警服务全套 58 项通过；原生日志到事实的源帧编号断言另外已复验。

仍需并发 worker 源码核对、完整构建、实际 GLES/JPU 归档和新接口联调、独立保留策略实际应用、现网及内置浏览器验收。独立保留源码与隔离测试已实现，VLM 复核仍只预留接口。

独立保留后续验证：告警全套 74 项（真实 Mongo/SSD/子进程崩溃）通过且无跳过，后台 15 项、前端相关 18 项及前后端类型检查通过。原生 JPEG 编码与真实摄像头事件仍需部署联调；测试 JPEG 夹具不代替 GLES/JPU 证明。

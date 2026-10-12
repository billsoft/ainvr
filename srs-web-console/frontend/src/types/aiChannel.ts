/**
 * AI 通道类型定义 —— 与常规 Channel（SRS 通道）不同，这里字段保持
 * snake_case 直通 ai-service 原始 JSON，不做 camelCase 映射：AI 通道的
 * 数据权威在 ai-service 侧（config_store），console 只是透传代理，
 * 不是自己的领域模型，映射层收益低、维护成本高。
 *
 * 字段形状已用真实设备实测核对（不是照文档抄的）：POST /api/v1/channels、
 * GET /api/v1/channels/{id}、PUT /api/v1/channels/{id}/config 三个接口
 * 返回值逐一验证过。
 */

/** 对齐 ai-service ChannelState 枚举（src/ai_service/pipeline/channel.py） */
export type AiChannelState = 'idle' | 'starting' | 'running' | 'error' | 'stopping' | 'reconnecting'

export interface AiReconnectConfig {
  enabled: boolean
  initial_delay: number
  max_delay: number
  backoff_factor: number
}

export interface AiStreamConfig {
  url: string
  protocol: 'rtmp' | 'flv' | 'auto'
  watchdog_timeout_seconds: number
  reconnect: AiReconnectConfig
}

export type AiModelAdapter = 'yolo26_bpu' | 'yoloface_bpu' | 'scrfd_bpu' | 'locateanything_bpu' | 'yoloe_bpu'
  | 'yolo26_end2end' | 'yolo26_traditional' | 'yolo26_trt' | 'yoloface_trt' | 'scrfd_trt' | 'locateanything_trt' | 'yoloe_pt'

export interface AiModelConfig {
  name: string
  adapter: AiModelAdapter
  path: string
  input_size: [number, number]
  stride: number
  provider: 'bpu' | 'cuda' | 'tensorrt' | 'cpu'
  engine_cache: string
  class_names: string[] | null
  description?: string
  label_id?: string
  label_name?: string
  max_new_tokens?: number
}

export interface AiPreprocessConfig {
  letterbox: boolean
  padding_color: [number, number, number]
  interpolation: 'nearest' | 'bilinear' | 'bicubic' | 'area' | 'lanczos4'
  normalize: boolean
  mean: [number, number, number]
  std: [number, number, number]
  rgb_order: boolean
  /** 2026-09-11 起后端固定拒绝非 0 值（config.py::PreprocessConfig 头注：
   * 两次生产画质事故都是这个字段被改非零导致识别历史截图取自 VIC 缩放后
   * 的小图）——恒为 0，字段保留只是镜像后端响应形状，前端向导不再提供
   * 编辑入口。 */
  ai_sample_width: number
  ai_sample_height: number
}

export interface AiPostprocessConfig {
  conf_threshold: number
  iou_threshold: number
  max_detections: number
}

export interface AiSeiConfig {
  max_payload_bytes: number
  match_window_ms: number
  format: 'json'
}

export interface AiOsdConfig {
  stale_ms: number
  box_thickness: number
  font_scale: number
  box_color: number[]
  text_color: number[]
  landmark_color: number[]
  landmark_radius: number
  draw_confidence: boolean
  bitrate_kbps: number
  iframe_interval: number
}

/** osd_encode 模式已下线（ai-service 侧 OsdPublisher/osd_draw.py 已删除），
 * 后端 mode 字段现在恒为 passthrough_sei（历史 osd_encode 配置读取时自动
 * 改写）。画框职责挪到本前端的浏览器端渲染器，不再需要区分两种模式。 */
export type AiPublishMode = 'passthrough_sei'

export interface AiPublishConfig {
  enabled: boolean
  mode: AiPublishMode
  rtmp_base: string
  target_url: string | null
  watchdog_timeout_seconds: number
  reconnect: AiReconnectConfig
  sei: AiSeiConfig
  osd: AiOsdConfig
  /** H.265 源时 AI 输出的 FLV 写法：codec12（默认，SRS/ffmpeg 等兼容面最广）或
   * enhanced（Enhanced RTMP，hvc1 FourCC）。H.264 源无意义；旧版 ai-service 无此字段。 */
  flv_format?: 'codec12' | 'enhanced'
  /** 服务端算好的实际推流目标地址（target_url 或 rtmp_base 派生名），
   * 播放衍生流必须用这个，不能自己拼 `${id}-ai`——target_url 用户可能改过。 */
  effective_target_url: string
}

/** 识别快照归档（识别历史）配置——ai-service SnapshotConfig 的镜像
 * （ai_service/config.py）。max_count 是精确保留条数（按识别框计，不是
 * 按帧）；enabled 之外的字段都能热更新，enabled 变更需要重启通道——见
 * ai-service SNAPSHOT_HOT_SUBFIELDS 头注，这一点决定了前端切换 enabled
 * 时要用带重启提示的确认弹窗，不能当成普通表单字段静默保存。 */
/** "none"=普通相机，直接裁 bbox；"erp_equirect"=全景相机自带拼接输出的
 * 标准 2:1 等距柱状全景图，裁剪前先做透视投影还原，见 ai-service
 * output/erp_perspective.py 头注。"distortion_correction"（鱼眼畸变矫正）
 * 后端还没实现，不出现在这个联合类型里——前端下拉列表单独用一个禁用态
 * 选项占位，不能选中，不能通过类型系统假装这个值合法。 */
export type AiSnapshotProjectionMode = 'none' | 'erp_equirect'

/** 人脸修复模型选择（对齐 ai-service snapshot.face_enhance_model）：
 * "none"=不增强原图存；"gpen"=256 档人脸修复模型，宽高都 <256 的小脸修到
 * 256x256，快（约 44 FPS）；"codeformer"=512 档高细节人脸修复模型，宽高都 <512
 * 时修到 512x512，细节更好但慢（约 10 FPS）。两种都走等比 letterbox
 * 灰边补齐，不拉伸。切换模型是结构性字段（要加载/更换 TRT engine），
 * 保存后通道重启。 */
export type AiFaceEnhanceModel = 'none' | 'gpen' | 'codeformer'

export interface AiSnapshotConfig {
  enabled: boolean
  max_count: number
  min_interval_ms: number
  jpeg_quality: number
  max_crop_dimension: number
  padding_ratio: number
  projection_mode: AiSnapshotProjectionMode
  /** 截图亮度（局部自适应曝光）校正开关。在写入线程里、人脸增强之前、
   *  JPEG 编码之前作用于裁剪图（ai-service output/exposure.py），纯 CPU
   *  图像计算，热更新、不重启、不影响推理帧率。默认关闭。 */
  brightness_enabled: boolean
  /** 目标亮度（Lab-L，80-180，128=中性）：暗景提亮、过曝压暗。
   *  热更新字段，brightness_enabled=false 时忽略。 */
  brightness_target: number
  /** 人脸修复模型，见 AiFaceEnhanceModel；旧后端可能不返回该字段，
   * 读取处统一按 'none' 处理。 */
  face_enhance_model: AiFaceEnhanceModel
  /** 增强强度混合系数 0-1：1=全量增强，0.5=半强度（生产默认），0=原图放大。
   * 热更新字段，保存后下一帧生效，不重启通道。对两个模型都生效。 */
  face_enhance_blend: number
}

export interface AiChannelConfig {
  deletion_pending?: boolean
  /** 服务端持久化的手动停止：AI 服务重启后仍保持停止，直到再次启动 */
  manually_stopped?: boolean
  name: string
  enabled: boolean
  stream: AiStreamConfig
  inference_fps: number
  max_consecutive_failures: number
  model: AiModelConfig
  preprocess: AiPreprocessConfig
  postprocess: AiPostprocessConfig
  result_buffer: { max_frames: number }
  publish: AiPublishConfig
  snapshot: AiSnapshotConfig
}

export interface AiTimingStat {
  count: number
  mean_ms: number
  p50_ms: number
  p95_ms: number
}

/** publish.enabled 时才有值——ai-service 的 StreamPublisher.get_stats()
 * (channel.py 里 stats["publish"] = self._publisher.get_stats())。
 * 注意 running 只代表本地发布管线线程还活着，不代表真的在往 SRS 推流
 * 成功——au_in/au_pushed/sei_injected 只反映本地吞吐，rtmp2sink 报错
 * 断流后这几个计数器仍可能正常递增；判断"是否正在发布异常"应该用
 * reconnecting，而不是 running（2026-09-09 复核：真实生产事故里
 * running=true 但 SRS 早已收不到流）。 */
export interface AiPublishStats {
  running: boolean
  rtmp_url: string
  au_in: number
  au_pushed: number
  sei_injected: number
  provider_errors: number
  reconnect_count: number
  consecutive_failures: number
  reconnecting: boolean
  last_error: string | null
  last_error_at: number | null
  /** 输出编码（与源相同：h264 / h265）与 H.265 的 FLV 写法（codec12 / enhanced）；旧版无 */
  codec?: string
  flv_format?: string
}

export interface AiChannelStats {
  state: AiChannelState
  elapsed_seconds: number
  frame_count: number
  inference_count: number
  /** 推理线程跳过的帧总数 = sampled_skip_count + overload_drop_count + archive_backpressure_skip_count */
  dropped_count: number
  /** 按设定推理帧率的正常抽帧（源 30fps、推理 15fps 时每次跳 1 帧），不是丢帧。
   * 旧版 ai-service 没有这几个拆分字段，读取处要兜底。 */
  sampled_skip_count?: number
  /** 推理跟不上源流的过载丢帧 */
  overload_drop_count?: number
  archive_backpressure_skip_count?: number
  /** 实测源帧率（帧到达间隔估算） */
  source_fps?: number
  /** 有效目标推理帧率 = min(设定值, 源帧率)，设定 0 时跟随源帧率 */
  inference_fps_target?: number
  /** 运行 10s 后实测推理帧率 < 有效目标的 90%：GPU 算力不够（多通道并行
   * 时"还能不能再加一路"的唯一信号） */
  under_capacity?: boolean
  /** 最近一次让通道进入 error 的原因(启动失败/源流不可恢复/推理连续失败),
   * 每次启动清空;旧版 ai-service 没有这个字段。 */
  last_error?: string | null
  consecutive_errors: number
  inference_fps_actual: number
  timing: {
    preprocess: AiTimingStat
    inference: AiTimingStat
    postprocess: AiTimingStat
    total: AiTimingStat
  }
  result_buffer_size: number
  publish?: AiPublishStats
  /** 源流编码（ai-service 经 SRS 识别：h264 / h265）；旧版 ai-service 无此字段 */
  video_codec?: string
  /** 仅 H.265 源：输入 FLV 写法、解封装丢帧数、tag 层重同步次数 */
  source_flv_format?: string
  demux_dropped_frames?: number
  demux_resyncs?: number
  /** 源含 B 帧（WebRTC 播放可能异常，建议相机关闭 B 帧） */
  source_bframes?: boolean
}

/** GET /channels、GET /channels/:id、POST /channels、PUT /channels/:id/config
 * 的 channel 字段，三处共用同一个形状（ai-service 侧 _channel_view()）。 */
export interface AiChannel {
  id: string
  name: string
  state: AiChannelState
  config: AiChannelConfig
  stats: AiChannelStats
}

/** PUT /channels/:id/config 的完整响应（架构 §11.3.5） */
export interface AiConfigUpdateResult {
  applied: boolean
  applied_via: 'hot' | 'restart'
  hot_fields: string[]
  restart: { reason: string; status: AiChannelState | 'failed' } | null
  channel: AiChannel
}

/** POST /channels 的创建 patch —— 顶层字段白名单，必须跟 ai-service 的
 * KNOWN_CHANNEL_FIELDS 保持一致（多传字段会被 pydantic extra="forbid"
 * 拒绝，422），id 只在创建时需要，编辑走 PATCHABLE_TOP_LEVEL_FIELDS。 */
export interface AiChannelCreatePatch {
  id: string
  name?: string
  enabled?: boolean
  stream: { url: string; protocol?: AiStreamConfig['protocol'] }
  inference_fps?: number
  max_consecutive_failures?: number
  model?: Partial<AiModelConfig>
  preprocess?: Partial<AiPreprocessConfig>
  postprocess?: Partial<AiPostprocessConfig>
  result_buffer?: { max_frames: number }
  publish?: {
    enabled?: boolean
    mode?: AiPublishMode
    target_url?: string | null
    sei?: Partial<AiSeiConfig>
    osd?: Partial<AiOsdConfig>
    flv_format?: 'codec12' | 'enhanced'
  }
  snapshot?: Partial<AiSnapshotConfig>
}

/** PUT /channels/:id/config 的编辑 patch —— 只允许这几个顶层键
 * （不含 id，见 httpAiChannelService.ts 的白名单兜底） */
export type AiChannelUpdatePatch = Partial<Omit<AiChannelCreatePatch, 'id'>>

/** GET /channels/:id/results/latest 里 detections[] 的单项 */
export interface AiDetection {
  class_id: number
  class_name: string
  confidence: number | null
  label_id?: string
  bbox: { x: number; y: number; w: number; h: number }
  /** 仅 scrfd_trt（人脸检测）填充，顺序固定 [左眼,右眼,鼻尖,左嘴角,右嘴角] */
  landmarks?: { x: number; y: number }[]
}

export interface AiFrameResult {
  schema_version: string
  channel_id: string
  stream_url: string
  stream_protocol: string
  timestamp: number
  frame_pts_ns: number
  frame_index: number
  frame_width: number
  frame_height: number
  model: {
    name: string
    format: string
    provider: string
    input_size: number[]
    end2end: boolean
    version: string
  }
  timing_ms: { decode: number; preprocess: number; inference: number; postprocess: number; total: number }
  task_type: 'object_detection' | 'face_detection' | string
  detections: AiDetection[]
  model_extra: Record<string, unknown>
}

/** GET /api/ai/streams（console 本地聚合 srsClient，不转发 ai-service） */
export interface AiStreamOption {
  app: string
  name: string
  clients: number
  bitrateKbps?: number
  videoCodec?: string
  videoLevel?: string
  videoWidth?: number
  videoHeight?: number
  h265: boolean
}

/** GET /api/ai/health（ai-service 自身健康检查，原样透传） */
export interface AiServiceHealth {
  status: string
  version: string
  uptime_seconds: number
  channels: number
  channels_running: number
  /** 宿主机磁盘剩余/总空间——主机级指标，不是某个通道的属性，识别历史
   * 页面顶部展示用。2026-09-10 新增字段，走 /health 原样透传。 */
  disk_free_bytes?: number
  disk_total_bytes?: number
  /** ai-service 声明的能力（2026-09-29 起）：没有该字段 = 旧版，只支持 H.264 源 */
  capabilities?: {
    codecs?: string[]
    publish_formats?: string[]
  }
}

/** 模型预设——切换卡片即写入整组原子字段，不能只切
 * model.* 本身（否则 SCRFD 会用 YOLO 的归一化参数推理出垃圾结果且不报错，
 * 见架构方案 D6）。provider 统一 tensorrt——cuda EP 本机实测不可用。 */
export const AI_MODEL_PRESETS = {
  'yoloe-26x': {
    displayName: '开放词汇模型', streamSlug: 'grounding-fast',
    needsIouThreshold: true, label: '开放词汇模型（YOLOE-26x）',
    description: '按文字描述检测目标，修改描述无需重新编译模型',
    model: {
      name: 'yoloe-26x', adapter: 'yoloe_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/yoloe-26x.hbm', input_size: [640, 640] as [number, number],
      stride: 32, provider: 'bpu' as const, engine_cache: '',
      class_names: null,
    },
    preprocess: { mean: [0, 0, 0] as [number, number, number],
      std: [255, 255, 255] as [number, number, number], rgb_order: true },
  },
  'locateanything-3b': {
    displayName: '开放词汇模型（高级）', streamSlug: 'grounding',
    needsIouThreshold: false, label: '开放词汇模型（高级）',
    description: '按文字描述定位目标，适合低频采集训练素材',
    model: {
      name: 'locateanything-3b', adapter: 'locateanything_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/locateanything-3b.hbm', input_size: [448, 448] as [number, number],
      stride: 32, provider: 'bpu' as const, engine_cache: '', class_names: null,
    },
    preprocess: { mean: [127.5, 127.5, 127.5] as [number, number, number],
      std: [127.5, 127.5, 127.5] as [number, number, number], rgb_order: true },
  },
  yolo26x: {
    displayName: '通用目标检测',
    streamSlug: 'yolo26x',
    needsIouThreshold: false,
    label: '通用目标检测（YOLO26x）',
    description: '80 类常见目标（人、车辆、动物等）',
    model: {
      name: 'yolo26x', adapter: 'yolo26_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/yolo26x.hbm',
      input_size: [640, 640] as [number, number], stride: 32,
      provider: 'bpu' as const, engine_cache: '', class_names: null,
    },
    preprocess: { mean: [0, 0, 0] as [number, number, number],
      std: [255, 255, 255] as [number, number, number], rgb_order: true },
  },
  // Legacy definitions remain for existing configurations and historical records.
  yolo26m: {
    displayName: '通用目标检测',
    streamSlug: 'yolo26m',
    needsIouThreshold: false,
    label: '通用目标检测',
    description: '80 类常见目标（人、车辆、动物等）',
    model: {
      name: 'yolo26m',
      adapter: 'yolo26_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/yolo26m.hbm',
      input_size: [640, 640] as [number, number],
      stride: 32,
      provider: 'bpu' as const,
      engine_cache: '',
      class_names: null,
    },
    preprocess: {
      mean: [0, 0, 0] as [number, number, number],
      std: [255, 255, 255] as [number, number, number],
      rgb_order: true,
    },
  },
  scrfd: {
    displayName: '人脸检测（含关键点）',
    streamSlug: 'scrfd',
    needsIouThreshold: true,
    label: '人脸检测（含关键点）',
    description: '人脸框 + 5 点关键点',
    model: {
      name: 'scrfd_10g_kps',
      adapter: 'scrfd_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/scrfd_10g_kps_640.hbm',
      input_size: [640, 640] as [number, number],
      stride: 32,
      provider: 'bpu' as const,
      engine_cache: '',
      class_names: ['face'],
    },
    preprocess: {
      // 实测确认：SCRFD 官方归一化 mean=127.5/std=128，RGB 顺序（不是
      // BGR——cv2.dnn.blobFromImage 的 swapRB=True 已经转成 RGB 喂给网络，
      // 这里直接吃 RGB 帧不需要再交换）。真实人脸照片跑通全链路验证过。
      mean: [127.5, 127.5, 127.5] as [number, number, number],
      std: [128, 128, 128] as [number, number, number],
      rgb_order: true,
    },
  },
  'yolov12m-face': {
    displayName: '人脸检测（标准）',
    streamSlug: 'yolov12m-face',
    needsIouThreshold: false,
    label: '人脸检测（标准）',
    description: '人脸框检测',
    model: {
      name: 'yolov12m-face',
      // yoloface_trt：yolo26_trt 的人脸专用子类，后处理把检测框以中心为
      // 不动点扩成正方形（入库截图无灰边 letterbox），仅人脸模型使用
      adapter: 'yoloface_bpu' as AiModelAdapter,
      path: 'models/derived/s100p/yolov12m-face.hbm',
      input_size: [640, 640] as [number, number],
      stride: 32,
      provider: 'bpu' as const,
      engine_cache: '',
      class_names: ['face'],
    },
    preprocess: {
      // YOLO 标准归一化：像素值除以 255，RGB 顺序
      mean: [0, 0, 0] as [number, number, number],
      std: [255, 255, 255] as [number, number, number],
      rgb_order: true,
    },
  },
  'yolo26x-face': {
    displayName: '人脸检测（高精度）',
    streamSlug: 'yolo26x-face',
    needsIouThreshold: false,
    label: '人脸检测（YOLO26x-face）',
    // S100P 纯推理与完整视频链路分别实测，不能沿用 Jetson/VIC 的帧率。
    // 编译和验证流程见 docs/S100P-HBM-COMPILATION.md。
    description: '人脸框检测，仅出框不含关键点；S100P 性能以 BPU 实测为准',
    model: {
      name: 'yolo26x-face',
      adapter: 'yoloface_bpu' as AiModelAdapter,
      // 预先编译并经板端验证的 HBM，配套 .hbm.ainvr.json 描述实际接口。
      // 原生 BPU 服务负责加载，首次访问不会现场编译或回退到 CPU。
      path: 'models/derived/s100p/yolo26x-face.hbm',
      input_size: [640, 640] as [number, number],
      stride: 32,
      provider: 'bpu' as const,
      engine_cache: '',
      class_names: ['face'],
    },
    preprocess: {
      // 跟 yolov12m-face 同一条 ultralytics 导出链路，同样的标准归一化
      mean: [0, 0, 0] as [number, number, number],
      std: [255, 255, 255] as [number, number, number],
      rgb_order: true,
    },
  },
} as const

export type AiModelPresetKey = keyof typeof AI_MODEL_PRESETS
export function isOpenVocabularyPreset(preset: AiModelPresetKey): boolean {
  return preset === 'locateanything-3b' || preset === 'yoloe-26x'
}

export const SELECTABLE_AI_MODEL_PRESET_KEYS: readonly AiModelPresetKey[] = [
  'yolo26x', 'yolo26x-face', 'yoloe-26x',
]
export const DEFAULT_AI_MODEL_PRESET: AiModelPresetKey = 'yolo26x'

export function getAiModelPresetByName(name: string) {
  return Object.values(AI_MODEL_PRESETS).find((preset) => preset.model.name === name)
}

/** 界面上的模型名：只显示任务名（"人脸检测（高精度）"等），不暴露模型/框架名。
 * 不在预设里的模型按 adapter 归到同类任务名，仍不认识的显示"自定义模型"。 */
export function getAiModelDisplayName(model: Pick<AiModelConfig, 'name' | 'adapter'>): string {
  return getAiModelPresetByName(model.name)?.displayName
    ?? Object.values(AI_MODEL_PRESETS).find((preset) => preset.model.adapter === model.adapter)?.displayName
    ?? '自定义模型'
}

/** 识别记录里只有模型名（model_name）时的显示名 */
export function getAiModelDisplayNameByName(name: string | null | undefined): string {
  return getAiModelPresetByName(name ?? '')?.displayName ?? (name ? '自定义模型' : '-')
}

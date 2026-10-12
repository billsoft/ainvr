import type {
  AiChannel, AiChannelCreatePatch, AiChannelUpdatePatch, AiConfigUpdateResult,
  AiFrameResult, AiServiceHealth, AiStreamOption, AiChannelState,
} from '@/types/aiChannel'
import { createHttpAiChannelService } from './httpAiChannelService'

/** AI 通道服务接口 —— 数据权威在 ai-service 侧（config_store），
 * console 只透传代理，不是自己持久化的领域模型 */
export interface AiChannelService {
  list(): Promise<AiChannel[]>
  get(id: string): Promise<AiChannel | null>
  create(patch: AiChannelCreatePatch): Promise<AiChannel>
  update(id: string, patch: AiChannelUpdatePatch): Promise<AiConfigUpdateResult>
  remove(id: string): Promise<void>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  latestResult(id: string): Promise<{ hasResult: boolean; result: AiFrameResult | null }>
  /** 最近 N 条推理结果（按时间升序），供浏览器端叠加层按时间戳对齐画面用——
   * 单条 latestResult 只有"最新一条"，可能跟当前画面对不上时间点；一小段
   * 历史窗口能挑出跟画面播放时钟最接近的那条，画出来的框不会飘。 */
  resultHistory(id: string, limit?: number): Promise<AiFrameResult[]>
  /** ai-service 不可达时返回 null（不抛错）——降级横幅靠这个判断，不是
   * catch 异常来判断，两者语义不同：null 明确表示"探测完成，结果是不可达" */
  health(): Promise<AiServiceHealth | null>
  listStreams(): Promise<AiStreamOption[]>
}

const delay = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms))

/** 内存 mock 实现，供单元测试/离线开发用，CRUD 语义与真实 HTTP 实现一致 */
export function createMockAiChannelService(seed: AiChannel[] = []): AiChannelService {
  const store = new Map<string, AiChannel>()
  for (const ch of seed) store.set(ch.id, structuredClone(ch))

  const emptyStats = (state: AiChannelState) => ({
    state, elapsed_seconds: 0, frame_count: 0, inference_count: 0, dropped_count: 0,
    consecutive_errors: 0, inference_fps_actual: 0,
    timing: {
      preprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 },
      inference: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 },
      postprocess: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 },
      total: { count: 0, mean_ms: 0, p50_ms: 0, p95_ms: 0 },
    },
    result_buffer_size: 0,
  })

  return {
    async list() {
      await delay()
      return [...store.values()].map((c) => structuredClone(c))
    },

    async get(id) {
      await delay()
      const ch = store.get(id)
      return ch ? structuredClone(ch) : null
    },

    async create(patch) {
      await delay()
      if (store.has(patch.id)) throw Object.assign(new Error(`通道已存在: ${patch.id}`), { status: 409 })
      const preset = patch.model?.adapter === 'scrfd_trt'
      const ch: AiChannel = {
        id: patch.id,
        name: patch.name ?? patch.id,
        state: 'idle',
        config: {
          name: patch.name ?? patch.id,
          enabled: patch.enabled ?? true,
          stream: { url: patch.stream.url, protocol: patch.stream.protocol ?? 'auto', watchdog_timeout_seconds: 5, reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 } },
          inference_fps: patch.inference_fps ?? 5,
          max_consecutive_failures: 10,
          model: {
            name: patch.model?.name ?? (preset ? 'scrfd_10g_kps' : 'yolo26m'),
            adapter: patch.model?.adapter ?? 'yolo26_trt',
            path: patch.model?.path ?? '',
            input_size: patch.model?.input_size ?? [640, 640],
            stride: patch.model?.stride ?? 32,
            provider: patch.model?.provider ?? 'tensorrt',
            engine_cache: patch.model?.engine_cache ?? 'trt_engine_cache/',
            class_names: patch.model?.class_names ?? null,
            ...(patch.model && ['locateanything_trt', 'yoloe_pt', 'locateanything_bpu', 'yoloe_bpu'].includes(patch.model.adapter ?? '') ? {
              description: patch.model.description, label_id: patch.model.label_id,
              label_name: patch.model.label_name, max_new_tokens: patch.model.max_new_tokens,
            } : {}),
          },
          preprocess: {
            letterbox: true, padding_color: [114, 114, 114], interpolation: 'bilinear', normalize: true,
            mean: patch.preprocess?.mean ?? [0, 0, 0],
            std: patch.preprocess?.std ?? [255, 255, 255],
            rgb_order: patch.preprocess?.rgb_order ?? true,
            ai_sample_width: patch.preprocess?.ai_sample_width ?? 0,
            ai_sample_height: patch.preprocess?.ai_sample_height ?? 0,
          },
          postprocess: {
            conf_threshold: patch.postprocess?.conf_threshold ?? 0.25,
            iou_threshold: patch.postprocess?.iou_threshold ?? 0.45,
            max_detections: patch.postprocess?.max_detections ?? 300,
          },
          result_buffer: patch.result_buffer ?? { max_frames: 30 },
          publish: {
            enabled: patch.publish?.enabled ?? false,
            mode: patch.publish?.mode ?? 'passthrough_sei',
            rtmp_base: 'rtmp://127.0.0.1:1935',
            target_url: patch.publish?.target_url ?? null,
            watchdog_timeout_seconds: 5,
            reconnect: { enabled: true, initial_delay: 1, max_delay: 60, backoff_factor: 2 },
            sei: { max_payload_bytes: patch.publish?.sei?.max_payload_bytes ?? 1024, match_window_ms: patch.publish?.sei?.match_window_ms ?? 0, format: 'json' },
            osd: {
              stale_ms: patch.publish?.osd?.stale_ms ?? 800,
              box_thickness: patch.publish?.osd?.box_thickness ?? 2,
              font_scale: patch.publish?.osd?.font_scale ?? 0.5,
              box_color: patch.publish?.osd?.box_color ?? [0, 255, 0, 255],
              text_color: patch.publish?.osd?.text_color ?? [255, 255, 255, 255],
              landmark_color: patch.publish?.osd?.landmark_color ?? [255, 0, 0, 255],
              landmark_radius: patch.publish?.osd?.landmark_radius ?? 3,
              draw_confidence: patch.publish?.osd?.draw_confidence ?? true,
              bitrate_kbps: patch.publish?.osd?.bitrate_kbps ?? 4000,
              iframe_interval: patch.publish?.osd?.iframe_interval ?? 30,
            },
            effective_target_url: patch.publish?.target_url ?? `rtmp://127.0.0.1:1935/live/${patch.id}-ai`,
          },
          snapshot: {
            enabled: patch.snapshot?.enabled ?? false,
            max_count: patch.snapshot?.max_count ?? 10000,
            min_interval_ms: patch.snapshot?.min_interval_ms ?? 0,
            jpeg_quality: patch.snapshot?.jpeg_quality ?? 82,
            max_crop_dimension: patch.snapshot?.max_crop_dimension ?? 320,
            padding_ratio: patch.snapshot?.padding_ratio ?? 0.25,
            projection_mode: patch.snapshot?.projection_mode ?? 'none',
            brightness_enabled: patch.snapshot?.brightness_enabled ?? false,
            brightness_target: patch.snapshot?.brightness_target ?? 128,
            face_enhance_model: patch.snapshot?.face_enhance_model ?? 'none',
            face_enhance_blend: patch.snapshot?.face_enhance_blend ?? 0.5,
          },
        },
        stats: emptyStats('idle'),
      }
      store.set(patch.id, ch)
      return structuredClone(ch)
    },

    async update(id, patch) {
      await delay()
      const cur = store.get(id)
      if (!cur) throw Object.assign(new Error(`通道不存在: ${id}`), { status: 404 })
      const restartFields = ['stream', 'model', 'preprocess', 'name', 'enabled'].filter((k) => k in patch)
      // 归档 enabled 是独立热开关，保留历史访问和既有任务，不重启推理/推流。
      // face_enhance_model 同样是结构性变更（要加载/更换人脸修复引擎），
      // 对齐 ai-service 侧分类：不在 SNAPSHOT_HOT_SUBFIELDS
      // 里，保存即重启；face_enhance_blend 是热更新，不加进来。
      if (patch.snapshot && 'face_enhance_model' in patch.snapshot) restartFields.push('snapshot.face_enhance_model')
      const next: AiChannel = {
        ...cur,
        // 顶层 name 跟 config.name 必须保持同步——真实 ai-service 的
        // _channel_view() 里两者都来自同一个 worker.cfg.name，不可能分裂；
        // 这里此前只更新了 config.name，顶层 name 留着旧值，是 mock 自己
        // 相对真实后端行为的失真（回归发现，AiChannel.name 应随 patch.name 同步更新）。
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        config: {
          ...cur.config,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.stream ? { stream: { ...cur.config.stream, ...patch.stream } } : {}),
          ...(patch.inference_fps !== undefined ? { inference_fps: patch.inference_fps } : {}),
          ...(patch.model ? { model: { ...cur.config.model, ...patch.model } } : {}),
          ...(patch.preprocess ? { preprocess: { ...cur.config.preprocess, ...patch.preprocess } } : {}),
          ...(patch.postprocess ? { postprocess: { ...cur.config.postprocess, ...patch.postprocess } } : {}),
          ...(patch.result_buffer ? { result_buffer: patch.result_buffer } : {}),
          ...(patch.publish
            ? {
                publish: {
                  ...cur.config.publish,
                  ...patch.publish,
                  sei: { ...cur.config.publish.sei, ...patch.publish.sei },
                  osd: { ...cur.config.publish.osd, ...patch.publish.osd },
                },
              }
            : {}),
          ...(patch.snapshot ? { snapshot: { ...cur.config.snapshot, ...patch.snapshot } } : {}),
        },
      }
      store.set(id, next)
      return {
        applied: true,
        applied_via: restartFields.length > 0 ? 'restart' : 'hot',
        hot_fields: Object.keys(patch).filter((k) => !restartFields.includes(k)),
        restart: restartFields.length > 0 ? { reason: `${restartFields.join('、')} 变更需要重启通道`, status: 'running' } : null,
        channel: structuredClone(next),
      }
    },

    async remove(id) {
      await delay()
      if (!store.has(id)) throw Object.assign(new Error(`通道不存在: ${id}`), { status: 404 })
      store.delete(id)
    },

    async start(id) {
      await delay()
      const cur = store.get(id)
      if (!cur) throw Object.assign(new Error(`通道不存在: ${id}`), { status: 404 })
      store.set(id, { ...cur, state: 'running', stats: { ...cur.stats, state: 'running' } })
    },

    async stop(id) {
      await delay()
      const cur = store.get(id)
      if (!cur) throw Object.assign(new Error(`通道不存在: ${id}`), { status: 404 })
      store.set(id, { ...cur, state: 'idle', stats: { ...cur.stats, state: 'idle' } })
    },

    async latestResult(_id) {
      await delay()
      return { hasResult: false, result: null }
    },

    async resultHistory(_id, _limit) {
      await delay()
      return []
    },

    async health() {
      await delay()
      return { status: 'ok', version: '0.1.0', uptime_seconds: 123, channels: store.size, channels_running: [...store.values()].filter((c) => c.state === 'running').length }
    },

    async listStreams() {
      await delay()
      return []
    },
  }
}

const isTestEnv =
  typeof import.meta !== 'undefined' &&
  import.meta.env &&
  (import.meta.env.MODE === 'test' || import.meta.env.VITEST === 'true')

export const aiChannelService: AiChannelService = isTestEnv
  ? createMockAiChannelService()
  : createHttpAiChannelService()

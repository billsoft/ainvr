import type {
  AiChannel, AiChannelCreatePatch, AiChannelUpdatePatch, AiConfigUpdateResult,
  AiFrameResult, AiServiceHealth, AiStreamOption,
} from '@/types/aiChannel'
import type { AiChannelService } from './aiChannelService'
import { request } from './httpClient'

// ⚠️ 这几条路由走 console 的 /api/ai/* 具名代理（backend/src/routes/aiProxy.ts），
// 响应体是 ai-service 原始 JSON，不是 console 自己路由那套 {code,data} 信封——
// 跟 systemService.ts / httpChannelService.ts 的响应解析方式不一样，别复制粘贴错。

/** 编辑通道时只允许发这几个顶层键——即使调用方（向导/识别历史页）传了多余
 * 字段也在这里过滤掉，不完全依赖调用方守规矩：ai-service 的
 * KNOWN_CHANNEL_FIELDS 白名单不包含 id，发过去会被 422 拒绝。 */
const PATCHABLE_TOP_LEVEL_FIELDS = [
  'name', 'enabled', 'stream', 'inference_fps', 'max_consecutive_failures',
  'model', 'preprocess', 'postprocess', 'result_buffer', 'publish', 'snapshot',
] as const

function filterPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of PATCHABLE_TOP_LEVEL_FIELDS) {
    if (key in patch) out[key] = patch[key]
  }
  return out
}

interface ChannelsListResponse { channels: AiChannel[] }
interface LatestResultResponse { channel_id: string; has_result: boolean; result: AiFrameResult | null }
interface HistoryResultsResponse { channel_id: string; count: number; results: AiFrameResult[] }
interface StreamsResponse { streams: AiStreamOption[] }

export function createHttpAiChannelService(): AiChannelService {
  return {
    async list() {
      const body = await request<ChannelsListResponse>('/ai/channels', { signal: AbortSignal.timeout(10000) })
      return body.channels
    },

    async get(id) {
      try {
        return await request<AiChannel>(`/ai/channels/${id}`)
      } catch (e: any) {
        if (e.status === 404) return null
        throw e
      }
    },

    async create(patch: AiChannelCreatePatch) {
      return await request<AiChannel>('/ai/channels', {
        method: 'POST',
        body: JSON.stringify(patch),
      })
    },

    async update(id, patch: AiChannelUpdatePatch) {
      return await request<AiConfigUpdateResult>(`/ai/channels/${id}/config`, {
        method: 'PUT',
        body: JSON.stringify(filterPatch(patch as Record<string, unknown>)),
      })
    },

    async remove(id) {
      await request<void>(`/ai/channels/${id}`, { method: 'DELETE' })
    },

    async start(id) {
      await request<void>(`/ai/channels/${id}/start`, { method: 'POST' })
    },

    async stop(id) {
      await request<void>(`/ai/channels/${id}/stop`, { method: 'POST' })
    },

    async latestResult(id) {
      const body = await request<LatestResultResponse>(`/ai/channels/${id}/results/latest`)
      return { hasResult: body.has_result, result: body.result }
    },

    async resultHistory(id, limit = 30) {
      const body = await request<HistoryResultsResponse>(`/ai/channels/${id}/results?limit=${limit}`)
      return body.results
    },

    async health() {
      try {
        return await request<AiServiceHealth>('/ai/health')
      } catch {
        // 502（不可达/超时/401 等）一律视为"探测完成，服务不可达"——
        // 降级横幅靠 null 判断，不靠 catch 到具体是哪种网络错误。
        return null
      }
    },

    async listStreams() {
      const body = await request<StreamsResponse>('/ai/streams', { signal: AbortSignal.timeout(10000) })
      return body.streams
    },
  }
}

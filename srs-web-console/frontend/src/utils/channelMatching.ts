import { getAiModelDisplayName, type AiChannel, type AiModelAdapter } from '@/types/aiChannel'
import type { ChannelWithStatus } from '@/types/channel'

/**
 * 从 AI 通道的 stream.url 中解析出 app/stream 段（忽略 host、协议、端口）
 *
 * 为什么不用字符串直接比：
 * AI 通道的 stream.url 可能是 rtmp://127.0.0.1:1935/live/xxx，也可能是
 * rtmp://192.168.100.183:1935/live/xxx，还可能是 rtmp://localhost:1935/live/xxx——
 * 同一个源流在不同配置里 host 写法不一样，字符串全等匹配必踩坑。
 *
 * 正确做法：解析出 app 和 stream 两个部分，和 SRS 通道的 upstream.app/
 * upstream.stream 结构化对比。
 */
export function parseStreamPath(url: string | null | undefined): { app: string; stream: string } | null {
  if (typeof url !== 'string' || !url.trim()) return null
  // 去掉协议前缀（rtmp://、http://、https://、flv:// 等）
  const normalized = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  const withoutProtocol = normalized.replace(/^[a-zA-Z]+:\/\//, '')
  // 去掉 host:port，只留路径部分
  const pathStart = withoutProtocol.indexOf('/')
  if (pathStart < 0) return null
  const path = withoutProtocol.slice(pathStart + 1) // 去掉开头的 /
  const parts = path.split('/')
  if (parts.length < 2) return null
  // app = 第一段，stream = 剩余部分用 / 拼回（支持多层级流名）
  const app = parts[0] as string
  const streamPath = parts.slice(1).join('/')
  const stream = /^https?:\/\//i.test(normalized)
    ? streamPath.replace(/\.flv$/i, '')
    : streamPath
  if (!app || !stream) return null
  return { app, stream }
}

/**
 * 流的身份键 `app/stream`：忽略协议/host/端口，去掉查询串和 http-flv 的
 * .flv 后缀。跟 ai-service 写入入口的输出冲突检查（control_server.cpp
 * StreamKey）同一口径——同一台 SRS 的 127.0.0.1 / 局域网 IP / localhost 是
 * 同一路流。
 */
export function streamKey(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim()) return null
  const parsed = parseStreamPath(url.trim().replace(/[?#].*$/, '').replace(/\/+$/, ''))
  if (!parsed) return null
  return `${parsed.app}/${parsed.stream.replace(/\.flv$/, '')}`
}

/**
 * 判断一个 AI 通道是否归属某个 SRS 通道（即它们的源流是同一个）
 */
export function isAiChannelOf(ai: AiChannel, ch: ChannelWithStatus): boolean {
  const parsed = parseStreamPath(ai.config.stream.url)
  if (!parsed) return false
  return parsed.app === ch.upstream.app && parsed.stream === ch.upstream.stream
}

/**
 * 从 AI 通道配置中提取模型显示名。
 * 优先使用后端真实模型名，adapter 只作为旧配置/缺少 name 时的兜底。
 */
export function getAiModelLabel(adapter: string, name?: string): string {
  // 界面只显示任务名，不显示模型/框架名（与 AI 通道卡片同一套映射）
  return getAiModelDisplayName({ adapter: adapter as AiModelAdapter, name: name ?? '' })
}

/**
 * 判断一个 AI 通道是不是"人脸检测"通道——决定识别历史设置里能不能开
 * "人脸增强后保存"。不能只看 adapter：生产环境的人脸通道用的是
 * yoloface_trt adapter + yolov12m-face 模型（class_names=['face']），
 * 只有 scrfd 才是 scrfd_trt。三级信号任一命中即判定：
 *   1. adapter === scrfd_trt
 *   2. 类别名里有 face（最直接，模型自己声明它检测脸）
 *   3. 模型名/文件路径含 face/scrfd（兜底，配置没写 class_names 时）
 */
export function isFaceDetectionModel(model: {
  adapter: string
  name?: string | null
  path?: string | null
  class_names?: string[] | null
}): boolean {
  if (model.adapter === 'scrfd_trt') return true
  if (model.adapter === 'yoloface_trt') return true
  if (model.class_names?.some((n) => n.toLowerCase() === 'face')) return true
  const haystack = `${model.name ?? ''} ${model.path ?? ''}`.toLowerCase()
  return haystack.includes('face') || haystack.includes('scrfd')
}

/**
 * 从 AI 通道产出输出流的简短名称（app/stream 格式，用于 T 型图展示）
 */
export function getAiOutputShortName(ai: AiChannel): string | undefined {
  if (!ai.config.publish.enabled || !ai.config.publish.effective_target_url) return undefined
  const parsed = parseStreamPath(ai.config.publish.effective_target_url)
  if (!parsed) return ai.config.publish.effective_target_url
  return `${parsed.app}/${parsed.stream}`
}

/**
 * 建一张"输出流 app/stream → 产出它的 AI 通道 id"映射表，给播放器场景
 * （实时监看宫格/聚焦、AI 通道自己的衍生流预览）判断"眼前这路流是不是
 * 某个 AI 通道的输出"、要不要在播放器里显示识别框叠加层开关用。
 *
 * 一路输出流理论上只会被一个 AI 通道产出（target_url 唯一），后出现的
 * 覆盖前面的只是防御性写法，不代表业务上允许多对一。
 */
export function buildAiOutputChannelIdMap(aiChannels: AiChannel[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const ai of aiChannels) {
    const key = getAiOutputShortName(ai)
    if (key) map.set(key, ai.id)
  }
  return map
}

/** 接入通道被哪些 AI 通道引用：作为识别源，或作为识别结果输出地址。 */
export function aiDependents(
  ch: { upstream: { app: string; stream: string } },
  aiChannels: AiChannel[],
): { sources: AiChannel[]; outputs: AiChannel[] } {
  const key = `${ch.upstream.app}/${ch.upstream.stream}`
  return {
    sources: aiChannels.filter((a) => streamKey(a.config.stream.url) === key),
    outputs: aiChannels.filter((a) => {
      const target = a.config.publish?.enabled ? a.config.publish.target_url : null
      return !!target && streamKey(target) === key
    }),
  }
}

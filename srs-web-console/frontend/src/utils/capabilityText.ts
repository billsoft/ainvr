import type { AiServiceHealth } from '@/types/aiChannel'
import { capabilitiesFromHealth } from '@/hooks/useAiServiceCapabilities'
import type { CodecSupport } from '@/utils/codec'

/** 系统配置"测试连接"与"关于"页共用的能力说明（设计 §8.4③⑤）。只读展示，不新增配置项。 */

function isHealth(v: unknown): v is AiServiceHealth {
  return !!v && typeof v === 'object' && typeof (v as { version?: unknown }).version === 'string'
}

export function describeAiService(health: unknown): string | null {
  if (!isHealth(health)) return null
  const caps = capabilitiesFromHealth(health)!
  if (!caps.h265) return `AI 服务 ${health.version} · 仅支持 H.264 源（升级后支持 H.265）`
  const formats = (health.capabilities?.publish_formats ?? ['codec12'])
    .map((f) => (f === 'enhanced' ? 'Enhanced' : f))
    .join(' / ')
  return `AI 服务 ${health.version} · 支持 H.264 / H.265 源（H.265 输出：${formats}）`
}

export function describeSrs(s: { srsVersion: string; srsVersionLive?: boolean; srsRtcHevc?: boolean }): string {
  if (s.srsVersionLive === false) return `未连上流媒体服务（显示的是设置里的版本 ${s.srsVersion}），无法判定 H.265 能力`
  return s.srsRtcHevc
    ? `流媒体服务 ${s.srsVersion} · 支持 H.265 实时播放（WebRTC）`
    : `流媒体服务 ${s.srsVersion} · 版本过低，H.265 通道无法 WebRTC 实时播放，将以 HLS 播放`
}

function lv(idc: number): string {
  return `L${idc / 30}`
}

/** 本机浏览器能力的逐项说明（关于页），与播放器判定用的是同一份探测结果 */
export function describeLocalSupport(s: CodecSupport): Array<[string, string]> {
  // 与 planLivePlayback 同序：先 hls.js（能转封装 TS 里的 HEVC），再原生 HLS
  const hls = s.mseHevcMaxLevel > 0
    ? `网页播放器，最高 ${lv(s.mseHevcMaxLevel)}`
    : s.nativeHlsHevcMaxLevel > 0 ? `原生 HLS，最高 ${lv(s.nativeHlsHevcMaxLevel)}（未实测）` : '不支持'
  const overlay = !s.encodedTransform
    ? '不可用（浏览器取不到逐帧识别数据）'
    : `可用（${s.encodedTransform === 'insertable-streams' ? 'Chrome 编码帧接口' : '标准编码帧接口'}）· ${
      s.videoFrameCallback ? '逐帧或近似，播放时判定' : '近似对齐'}`
  return [
    ['H.265 实时（WebRTC）', s.webrtcH265 ? '支持' : '不支持'],
    ['H.265 实时（HLS 兜底）', hls],
    ['H.265 录像回放', s.fileHevcMaxLevel > 0 ? `最高 ${lv(s.fileHevcMaxLevel)}` : '不支持'],
    ['识别框叠加', overlay],
  ]
}

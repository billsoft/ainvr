import { describe, expect, it } from 'vitest'
import { describeAiService, describeSrs } from '@/utils/capabilityText'

// 系统配置"测试连接"/"关于"页的能力说明（设计 §8.4③⑤）：版本 + H.265 能力，一句话说清
describe('describeAiService', () => {
  it('声明了 h265 → 支持 H.265 源，并列出输出封装', () => {
    expect(describeAiService({ status: 'ok', version: '2.3.0', uptime_seconds: 1, channels: 0, channels_running: 0,
      capabilities: { codecs: ['h264', 'h265'], publish_formats: ['codec12', 'enhanced'] } }))
      .toBe('AI 服务 2.3.0 · 支持 H.264 / H.265 源（H.265 输出：codec12 / Enhanced）')
  })
  it('没有 capabilities 的旧版 → 仅 H.264，提示升级', () => {
    expect(describeAiService({ status: 'ok', version: '2.2.0', uptime_seconds: 1, channels: 0, channels_running: 0 }))
      .toBe('AI 服务 2.2.0 · 仅支持 H.264 源（升级后支持 H.265）')
  })
  it('不是 health 形状 → null', () => {
    expect(describeAiService(undefined)).toBeNull()
    expect(describeAiService({ foo: 1 })).toBeNull()
  })
})

describe('describeSrs', () => {
  it('实时版本支持 H.265 WebRTC', () => {
    expect(describeSrs({ srsVersion: '7.0.162', srsVersionLive: true, srsRtcHevc: true }))
      .toBe('流媒体服务 7.0.162 · 支持 H.265 实时播放（WebRTC）')
  })
  it('版本过低（如回滚）→ 说明 H.265 走 HLS，不写组件名和版本门槛', () => {
    expect(describeSrs({ srsVersion: '6.0.191', srsVersionLive: true, srsRtcHevc: false }))
      .toBe('流媒体服务 6.0.191 · 版本过低，H.265 通道无法 WebRTC 实时播放，将以 HLS 播放')
  })
  it('连不上流媒体服务 → 标明不是实时版本', () => {
    expect(describeSrs({ srsVersion: '6.0.191', srsVersionLive: false, srsRtcHevc: false }))
      .toContain('未连上流媒体服务')
  })
})

describe('describeLocalSupport（关于页：本机能力，现场排查用）', () => {
  it('无 MSE 的 Safari 形态：WebRTC 不行、只有原生 HLS、标准编码帧接口 + rVFC', async () => {
    const { describeLocalSupport } = await import('@/utils/capabilityText')
    expect(describeLocalSupport({
      webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 153, fileHevcMaxLevel: 153,
      encodedTransform: 'script-transform', videoFrameCallback: true,
    })).toEqual([
      ['H.265 实时（WebRTC）', '不支持'],
      ['H.265 实时（HLS 兜底）', '原生 HLS，最高 L5.1（未实测）'],
      ['H.265 录像回放', '最高 L5.1'],
      ['识别框叠加', '可用（标准编码帧接口）· 逐帧或近似，播放时判定'],
    ])
  })
  it('什么都没有', async () => {
    const { describeLocalSupport } = await import('@/utils/capabilityText')
    const rows = describeLocalSupport({
      webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0,
      encodedTransform: null, videoFrameCallback: false,
    })
    expect(rows.map((r) => r[1])).toEqual(['不支持', '不支持', '不支持', '不可用（浏览器取不到逐帧识别数据）'])
  })
})

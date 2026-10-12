import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpChannelService } from '@/api/httpChannelService'

// 回归：BFF 早就透出 status.videoCodec，但前端映射层把它丢了——通道详情"视频编码"
// 永远显示 "-"，H.265 判定也永远拿不到值。现在连同 level/分辨率一起映射，播放器
// 按码流真实参数判定本机能否播放 H.265（设计 §8.2）。
describe('httpChannelService 状态映射', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('videoCodec / videoLevel / 分辨率从 BFF 透传到前端 status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        data: [{
          id: 'c1', name: '大门', upstreamProtocol: 'rtmp', streamName: 'cam', downstreamProtocols: ['webrtc'],
          createdAt: 0, updatedAt: 0,
          status: {
            online: true, clients: 1, bitrate: 900, srsOnline: true,
            videoCodec: 'HEVC', videoLevel: '5.1', videoWidth: 3840, videoHeight: 2160,
          },
        }],
      }),
    }) as unknown as typeof fetch
    const [ch] = await createHttpChannelService().list()
    expect(ch!.status).toMatchObject({
      online: true, videoCodec: 'HEVC', videoLevel: '5.1', videoWidth: 3840, videoHeight: 2160,
    })
  })
})

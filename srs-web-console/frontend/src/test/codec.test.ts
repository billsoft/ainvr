import {
  canPlayHevcFile, computeCodecSupport, formatCodec, hevcLevelIdc, hvc1Mime, isH265, planLivePlayback,
  type CodecSupport,
} from '@/utils/codec'

describe('isH265 / formatCodec', () => {
  it('认 SRS 实测值 HEVC，也认各种 H.265 写法', () => {
    for (const c of ['HEVC', 'hevc', 'H265', 'h265', 'H.265']) expect(isH265(c)).toBe(true)
    for (const c of ['H264', 'avc', '', null, undefined, 'VP9']) expect(isH265(c)).toBe(false)
  })
  it('显示为 H.264 / H.265，未知为 -', () => {
    expect(formatCodec('HEVC')).toBe('H.265')
    expect(formatCodec('h265')).toBe('H.265')
    expect(formatCodec('H264')).toBe('H.264')
    expect(formatCodec('h264')).toBe('H.264')
    expect(formatCodec(undefined)).toBe('-')
    expect(formatCodec('vp9')).toBe('VP9')
  })
})

describe('hevcLevelIdc：按码流真实参数定档，不一律按 4K 探测', () => {
  it('SRS 报的 level 字符串 → level_idc（×30）', () => {
    expect(hevcLevelIdc({ level: '5.1' })).toBe(153)
    expect(hevcLevelIdc({ level: '4' })).toBe(120)
    expect(hevcLevelIdc({ level: '3.1' })).toBe(93)
    expect(hevcLevelIdc({ level: 4.1 })).toBe(123)
  })
  it('没有 level 时按分辨率推最低档', () => {
    expect(hevcLevelIdc({ width: 1280, height: 720 })).toBe(93)
    expect(hevcLevelIdc({ width: 1920, height: 1080 })).toBe(120)
    expect(hevcLevelIdc({ width: 3840, height: 2160 })).toBe(150)
    expect(hevcLevelIdc({ width: 7680, height: 4320 })).toBe(180)
  })
  it('什么都不知道 → null（不猜）；非法 level 不当真', () => {
    expect(hevcLevelIdc({})).toBeNull()
    expect(hevcLevelIdc(undefined)).toBeNull()
    expect(hevcLevelIdc({ level: 'abc', width: 1920, height: 1080 })).toBe(120)
  })
  it('hvc1Mime 按档位生成 codecs 串', () => {
    expect(hvc1Mime(93)).toBe('video/mp4; codecs="hvc1.1.6.L93.B0"')
  })
})

describe('computeCodecSupport', () => {
  // 只支持到 L4.1 的设备：1080p 能播、4K 不能
  const upTo = (max: number) => (mime: string) => {
    const m = /\.L(\d+)\./.exec(mime)
    return !!m && Number(m[1]) <= max
  }

  it('逐档探测，记录各播放途径能播的最高档位', () => {
    const s = computeCodecSupport({
      getVideoCodecs: () => [{ mimeType: 'video/VP8' }, { mimeType: 'video/H265' }],
      isTypeSupported: upTo(123),
      canPlayType: (m) => (m.includes('mpegurl') ? 'maybe' : upTo(153)(m) ? 'probably' : ''),
      hasInsertableStreams: true,
      hasScriptTransform: true,
      hasVideoFrameCallback: true,
    })
    expect(s).toEqual<CodecSupport>({
      webrtcH265: true,
      mseHevcMaxLevel: 123,
      nativeHlsHevcMaxLevel: 153,
      fileHevcMaxLevel: 153,
      encodedTransform: 'insertable-streams',
      videoFrameCallback: true,
    })
  })
  it('没有原生 HLS 时原生档位为 0（能播 hvc1 文件不代表能原生播 HLS）', () => {
    const s = computeCodecSupport({ canPlayType: (m) => (m.includes('mpegurl') ? '' : 'probably') })
    expect(s.nativeHlsHevcMaxLevel).toBe(0)
    expect(s.fileHevcMaxLevel).toBeGreaterThan(0)
  })
  it('Safari 形态：只有 RTCRtpScriptTransform', () => {
    expect(computeCodecSupport({ hasScriptTransform: true }).encodedTransform).toBe('script-transform')
  })
  it('探针抛错/缺失一律按不支持，绝不抛出', () => {
    const s = computeCodecSupport({
      getVideoCodecs: () => { throw new Error('x') },
      isTypeSupported: () => { throw new Error('x') },
      canPlayType: () => { throw new Error('x') },
    })
    expect(s).toEqual<CodecSupport>({
      webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0,
      encodedTransform: null, videoFrameCallback: false,
    })
  })
})

describe('planLivePlayback（设计 §8.3）', () => {
  const all = ['webrtc', 'flv', 'hls']
  const none: CodecSupport = {
    webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0,
    encodedTransform: null, videoFrameCallback: false,
  }
  const hd = 120 // 1080p

  it('H.264：维持现状（服务端能力未知也不等）', () => {
    expect(planLivePlayback('H264', none, { rtcHevc: null }, all, hd)).toEqual({ kind: 'default' })
  })
  it('H.265 服务端能力还没拿到 → 等待，不先按不支持处理', () => {
    expect(planLivePlayback('HEVC', { ...none, webrtcH265: true }, { rtcHevc: null }, all, hd).kind).toBe('pending')
  })
  it('服务端能力查询失败（unknown）→ 先保守走 HLS，原因写"无法确认、正在重试"，不冒充"版本过低"', () => {
    const p = planLivePlayback('HEVC', { ...none, webrtcH265: true, mseHevcMaxLevel: 153 }, { rtcHevc: 'unknown' }, all, hd)
    expect(p).toMatchObject({ kind: 'hls', engine: 'hlsjs' })
    expect(p.kind === 'hls' && p.reason).toContain('正在重试')
    expect(p.kind === 'hls' && p.reason).not.toContain('7.0.33')
  })
  it('H.265 + 服务端支持 + 本机支持 → 只走 WebRTC', () => {
    expect(planLivePlayback('HEVC', { ...none, webrtcH265: true }, { rtcHevc: true }, all, hd).kind).toBe('webrtc')
  })
  it('服务端不支持（回滚到 SRS 6）→ 不硬走 WebRTC，改 HLS 并说明原因', () => {
    const p = planLivePlayback('HEVC', { ...none, webrtcH265: true, mseHevcMaxLevel: 153 }, { rtcHevc: false }, all, hd)
    expect(p).toMatchObject({ kind: 'hls', engine: 'hlsjs' })
    expect(p.kind === 'hls' && p.reason).toContain('版本过低')
  })
  it('只有原生 HLS 能播 H.265 的设备走原生 HLS（最后手段），不误判不支持', () => {
    const p = planLivePlayback('HEVC', { ...none, nativeHlsHevcMaxLevel: 153 }, { rtcHevc: true }, all, hd)
    expect(p).toMatchObject({ kind: 'hls', engine: 'native' })
  })
  it('两条 HLS 路都通时优先 hls.js：SRS 的 HLS 分片是 TS，Apple 原生 HLS 规范要求 HEVC 用 fMP4；'
    + 'hls.js 1.7 自带 HEVC-in-TS 解析、转封装成 fMP4 喂 MSE/ManagedMediaSource（iPad 17+ 也有）', () => {
    const p = planLivePlayback('HEVC', { ...none, nativeHlsHevcMaxLevel: 153, mseHevcMaxLevel: 153 }, { rtcHevc: false }, all, hd)
    expect(p).toMatchObject({ kind: 'hls', engine: 'hlsjs' })
  })
  it('按码流档位判定：设备到 L4.1，1080p 能播、4K 不能', () => {
    const s = { ...none, mseHevcMaxLevel: 123 }
    expect(planLivePlayback('HEVC', s, { rtcHevc: false }, all, 120).kind).toBe('hls')
    const p = planLivePlayback('HEVC', s, { rtcHevc: false }, all, 153)
    expect(p.kind).toBe('unsupported')
    expect(p.kind === 'unsupported' && p.reason).toContain('L5.1')
  })
  it('档位未知时只要求能播最低档，由实际播放结果兜底', () => {
    expect(planLivePlayback('HEVC', { ...none, mseHevcMaxLevel: 93 }, { rtcHevc: false }, all, null).kind).toBe('hls')
  })
  it('本机都不行 → 明确不可播，不黑屏', () => {
    const p = planLivePlayback('HEVC', none, { rtcHevc: true }, all, hd)
    expect(p.kind).toBe('unsupported')
    expect(p.kind === 'unsupported' && p.reason).toContain('此设备不支持')
  })
  it('通道没开 HLS 时不能降级到 HLS', () => {
    expect(planLivePlayback('HEVC', { ...none, mseHevcMaxLevel: 153 }, { rtcHevc: true }, ['webrtc'], hd).kind)
      .toBe('unsupported')
  })
})

describe('8K（等级 6.1 / 6.2）', () => {
  it('SRS 报 "6.1" 的 8K 码流 → 183；能播 6.1 的设备按支持判定，不误判不可播', () => {
    expect(hevcLevelIdc({ level: '6.1', width: 7680, height: 3840 })).toBe(183)
    const upTo = (max: number) => (mime: string) => Number(/\.L(\d+)\./.exec(mime)?.[1]) <= max
    const s = computeCodecSupport({ isTypeSupported: upTo(186), canPlayType: (m) => (upTo(186)(m) ? 'probably' : '') })
    expect(s.mseHevcMaxLevel).toBe(186)
    expect(s.fileHevcMaxLevel).toBe(186)
    const none = { webrtcH265: false, mseHevcMaxLevel: 0, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0, encodedTransform: null, videoFrameCallback: false } as const
    expect(planLivePlayback('HEVC', { ...none, mseHevcMaxLevel: 183 }, { rtcHevc: false }, ['webrtc', 'hls'], 183).kind).toBe('hls')
    expect(canPlayHevcFile({ fileHevcMaxLevel: 186 }, 183)).toBe(true)
  })
  it('只到 6.0 的设备播 6.1 码流 → 明确说明档位不够', () => {
    const none = { webrtcH265: false, mseHevcMaxLevel: 180, nativeHlsHevcMaxLevel: 0, fileHevcMaxLevel: 0, encodedTransform: null, videoFrameCallback: false } as const
    const p = planLivePlayback('HEVC', none, { rtcHevc: false }, ['webrtc', 'hls'], 183)
    expect(p.kind === 'unsupported' && p.reason).toContain('最高到 L6，本路码流为 L6.1')
  })
})

describe('canPlayHevcFile（录像回放）', () => {
  it('按分段档位判定；未知档位按最低档', () => {
    const s = { fileHevcMaxLevel: 123 }
    expect(canPlayHevcFile(s, 120)).toBe(true)
    expect(canPlayHevcFile(s, 153)).toBe(false)
    expect(canPlayHevcFile(s, null)).toBe(true)
    expect(canPlayHevcFile({ fileHevcMaxLevel: 0 }, null)).toBe(false)
  })
})

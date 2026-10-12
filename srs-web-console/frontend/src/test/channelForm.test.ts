import {
  DEFAULT_WIZARD_VALUE,
  fromChannel,
  generateStreamName,
  toServiceInput,
  validateStep1,
  validateStep2,
  validateStep3,
  type WizardFormValue,
} from '@/features/channelForm'

const valid: WizardFormValue = {
  name: '大门摄像头',
  description: '备注',
  sourceType: 'push',
  rtspUrl: '',
  upstreamProtocol: 'rtmp',
  app: 'live',
  stream: 'cam-1',
  protocols: ['flv', 'hls'],
  primary: 'flv',
}

describe('validateStep1 基本信息', () => {
  it('通过：无错误', () => {
    expect(validateStep1(valid)).toEqual({})
  })
  it('名称为空/纯空格报错', () => {
    expect(validateStep1({ ...valid, name: '' }).name).toBeTruthy()
    expect(validateStep1({ ...valid, name: '   ' }).name).toBeTruthy()
  })
  it('名称超 50 字报错', () => {
    expect(validateStep1({ ...valid, name: '长'.repeat(51) }).name).toBeTruthy()
    expect(validateStep1({ ...valid, name: '长'.repeat(50) }).name).toBeUndefined()
  })
  it('RTSP 来源必须填合法 rtsp 地址', () => {
    const rtsp = { ...valid, sourceType: 'rtsp' as const, rtspUrl: '' }
    expect(validateStep1(rtsp).rtspUrl).toBeTruthy()
    expect(
      validateStep1({ ...rtsp, rtspUrl: 'rtsp://192.168.1.50:554/stream1' }).rtspUrl,
    ).toBeUndefined()
    expect(
      validateStep1({ ...rtsp, rtspUrl: 'http://not-rtsp/path' }).rtspUrl,
    ).toBeTruthy()
  })
  it('直推来源不校验 rtspUrl', () => {
    expect(validateStep1({ ...valid, rtspUrl: '垃圾数据' }).rtspUrl).toBeUndefined()
  })
})

describe('validateStep2 推流配置', () => {
  it('通过：无错误', () => {
    expect(validateStep2(valid)).toEqual({})
  })
  it('app/stream 非法字符报错', () => {
    expect(validateStep2({ ...valid, app: 'live room' }).app).toBeTruthy()
    expect(validateStep2({ ...valid, stream: '中文名' }).stream).toBeTruthy()
    expect(validateStep2({ ...valid, stream: '' }).stream).toBeTruthy()
  })
  it('合法字符集 a-zA-Z0-9_- 通过', () => {
    expect(validateStep2({ ...valid, stream: 'Cam_01-a' }).stream).toBeUndefined()
  })
})

describe('validateStep3 下行协议', () => {
  it('通过：无错误', () => {
    expect(validateStep3(valid)).toBeNull()
  })
  it('未启用任何协议报错', () => {
    expect(validateStep3({ ...valid, protocols: [] })).toBe('至少启用一个下行协议')
  })
  it('primary 不在已启用集合报错', () => {
    expect(
      validateStep3({ ...valid, protocols: ['flv'], primary: 'hls' }),
    ).toBe('默认播放协议必须在已启用的协议中')
  })
})

describe('generateStreamName', () => {
  it('中文转为 - 连接的 slug 并带随机后缀', () => {
    const name = generateStreamName('大门摄像头')
    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(name.split('-').length).toBeGreaterThanOrEqual(2)
  })
  it('纯中文不可转写时回退 stream- 前缀', () => {
    const name = generateStreamName('监控')
    expect(name).toMatch(/^stream-[a-z0-9]{6}$/)
  })
  it('两次生成不同（随机后缀）', () => {
    expect(generateStreamName('cam')).not.toBe(generateStreamName('cam'))
  })
})

describe('toServiceInput / fromChannel 转换', () => {
  it('toServiceInput：rtsp 来源正确装配协议与 rtspUrl', () => {
    const out = toServiceInput({ ...valid, sourceType: 'rtsp', rtspUrl: 'rtsp://h/s' })
    expect(out.upstream.protocol).toBe('rtsp')
    expect(out.upstream.rtspUrl).toBe('rtsp://h/s')
  })
  it('toServiceInput：直推来源不带 rtspUrl、空备注转 undefined', () => {
    const out = toServiceInput({ ...valid, description: '  ' })
    expect(out.upstream.rtspUrl).toBeUndefined()
    expect(out.description).toBeUndefined()
  })
  it('toServiceInput：protocols 复制而非引用', () => {
    const v = { ...valid, protocols: ['flv' as const] }
    const out = toServiceInput(v)
    out.downstream.protocols.push('hls')
    expect(v.protocols).toEqual(['flv'])
  })
  it('fromChannel：roundtrip 往返一致（rtsp 场景 upstreamProtocol 回退 rtmp）', () => {
    const rtspCh = {
      name: 'RTSP通道',
      upstream: {
        protocol: 'rtsp' as const,
        app: 'live',
        stream: 's1',
        rtspUrl: 'rtsp://h/s1',
      },
      downstream: { protocols: ['flv' as const], primary: 'flv' as const },
    }
    const v = fromChannel(rtspCh)
    expect(v.sourceType).toBe('rtsp')
    expect(v.rtspUrl).toBe('rtsp://h/s1')
    const back = toServiceInput(v)
    expect(back.upstream.protocol).toBe('rtsp')
    expect(back.upstream.rtspUrl).toBe('rtsp://h/s1')
  })
  it('DEFAULT_WIZARD_VALUE 是合法初始值', () => {
    expect(validateStep1(DEFAULT_WIZARD_VALUE).name).toBeTruthy()
    expect(validateStep2(DEFAULT_WIZARD_VALUE).stream).toBeTruthy()
    expect(validateStep3(DEFAULT_WIZARD_VALUE)).toBeNull()
  })
})

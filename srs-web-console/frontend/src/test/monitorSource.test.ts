import { expect, it } from 'vitest'
import { buildMonitorSources } from '@/utils/monitorSource'
import { mockChannels } from '@/mock/channels'

const source = () => structuredClone(mockChannels[0]!)
const output = () => ({ ...source(), id: 'ai-output', name: '人员识别输出', upstream: { protocol: 'rtmp' as const, app: 'live', stream: 'result' } })

it('preserves a shared original camera for two independent AI outputs', () => {
  const input = source(), first = output(), second = { ...output(), id: 'second-output', upstream: { ...output().upstream, stream: 'second' } }
  const result = buildMonitorSources([input, first, second], new Map([['live/result', 'p1'], ['live/second', 'p2']]), new Map([[input.id, [first, second]]]), [])
  expect(result.get(first.id)?.text).toBe(`来源：${input.name}`)
  expect(result.get(second.id)?.text).toBe(`来源：${input.name}`)
  expect(result.get(first.id)?.protocol).toBe('RTMP')
})

it('labels GB cameras as GB/T 28181 rather than the internal RTMP bridge', () => {
  const input = source(), ai = output()
  const result = buildMonitorSources([input, ai], new Map([['live/result', 'p1']]), new Map([[input.id, [ai]]]), [{ input_id: input.id, device_id: '34020000001320000001', channel_id: '34020000001320000002' }])
  expect(result.get(ai.id)?.protocol).toBe('GB/T 28181')
  expect(result.get(ai.id)?.detail).toContain('国标设备：34020000001320000001')
  expect(result.get(ai.id)?.detail).toContain('网关转发：RTMP')
})

it('shows ONVIF/RTSP host without disclosing URL credentials or query parameters', () => {
  const input = { ...source(), onvif: { deviceId: 'dev', deviceVersion: 1, service: 'media1' as const, profileToken: 'profile1', videoSource: 'sensor1' }, upstream: { protocol: 'rtsp' as const, app: 'live', stream: 'camera', rtspUrl: 'rtsp://operator:private-password@192.168.1.20:554/private-path?token=private-token' } }
  const info = buildMonitorSources([input], new Map(), new Map(), []).get(input.id)!
  expect(info.protocol).toBe('ONVIF / RTSP')
  expect(info.text).toBe('输入：192.168.1.20:554')
  expect(JSON.stringify(info)).not.toMatch(/operator|private-password|private-token|private-path/)
})

it('does not guess a missing, cyclic or ambiguous AI source', () => {
  const input = source(), ai = output(), other = { ...source(), id: 'other' }
  const outputs = new Map([['live/result', 'p1']])
  for (const links of [new Map(), new Map([[ai.id, [ai]]]), new Map([[input.id, [ai]], [other.id, [ai]]])]) {
    expect(buildMonitorSources([input, ai, other], outputs, links, []).get(ai.id)?.protocol).toBe('来源待确认')
  }
})

it('traces an AI chain to the original input and keeps offline source metadata', () => {
  const input = { ...source(), status: { ...source().status, online: false } }, ai = output(), next = { ...output(), id: 'next', upstream: { ...output().upstream, stream: 'next' } }
  const result = buildMonitorSources([input, ai, next], new Map([['live/result', 'p1'], ['live/next', 'p2']]), new Map([[input.id, [ai]], [ai.id, [next]]]), [])
  expect(result.get(next.id)?.text).toBe(`来源：${input.name}`)
})

it('keeps unknown ingress explicit until GB metadata loads and for unregistered streams', () => {
  const input = source()
  expect(buildMonitorSources([input], new Map(), new Map(), null).get(input.id)?.protocol).toBe('来源待确认')
  expect(buildMonitorSources([{ ...input, registered: false }], new Map(), new Map(), []).get(input.id)?.protocol).toBe('来源待确认')
  expect(buildMonitorSources([input], new Map(), new Map(), []).get(input.id)?.protocol).toBe('RTMP')
})

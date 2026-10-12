import { describe, expect, it } from 'vitest'
import { parseStreamPath, streamKey } from '@/utils/channelMatching'
describe('channel list without AI output', () => {
  it('accepts missing, null and empty output addresses', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(parseStreamPath(value)).toBeNull()
      expect(streamKey(value)).toBeNull()
    }
  })
  it('matches the same input identity across HTTP FLV and RTMP', () => {
    expect(streamKey('http://127.0.0.1:8080/live/xm.flv')).toBe('live/xm')
    expect(streamKey('rtmp://192.168.100.189:1935/live/xm')).toBe('live/xm')
  })
})

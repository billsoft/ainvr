import { buildPlayUrl, buildPushUrl, formatBitrate, formatDuration, formatBytes, formatRelativeTime } from '@/utils/format'

describe('formatBitrate', () => {
  it('kbps 分级格式化', () => {
    expect(formatBitrate(2415)).toBe('2.4 Mbps')
    expect(formatBitrate(1000)).toBe('1.0 Mbps')
    expect(formatBitrate(870)).toBe('870 kbps')
    expect(formatBitrate(0)).toBe('-')
    expect(formatBitrate(undefined)).toBe('-')
    expect(formatBitrate(-5)).toBe('-')
  })
})

describe('formatDuration', () => {
  it('秒/分/时/天 分级', () => {
    expect(formatDuration(30)).toBe('30秒')
    expect(formatDuration(45 * 60 + 12)).toBe('45分')
    expect(formatDuration(5 * 3600 + 30 * 60)).toBe('5小时30分')
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2天3小时')
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(undefined)).toBe('-')
    expect(formatDuration(-1)).toBe('-')
  })
})

describe('formatBytes', () => {
  it('字节/KB/MB/GB 分级', () => {
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(1536)).toBe('1.5KB')
    expect(formatBytes(1234567)).toBe('1.2MB')
    expect(formatBytes(1234567890)).toBe('1.1GB')
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(undefined)).toBe('-')
    expect(formatBytes(-1)).toBe('-')
  })
})

describe('formatRelativeTime', () => {
  it('分级相对时间', () => {
    const now = Date.now() / 1000
    expect(formatRelativeTime(now - 5)).toBe('刚刚')
    expect(formatRelativeTime(now - 90)).toBe('1分钟前')
    expect(formatRelativeTime(now - 2 * 3600)).toBe('2小时前')
    expect(formatRelativeTime(now - 3 * 86400)).toBe('3天前')
    expect(formatRelativeTime(null)).toBe('-')
  })

  it('超过 7 天给绝对日期，不是"N天前"', () => {
    const now = Date.now() / 1000
    const result = formatRelativeTime(now - 10 * 86400)
    expect(result).not.toContain('天前')
  })
})

describe('buildPushUrl', () => {
  const i = { host: '192.168.100.183', app: 'live', stream: 'cam1' }
  it('各协议生成正确地址', () => {
    expect(buildPushUrl('rtmp', i)).toBe('rtmp://192.168.100.183:1935/live/cam1')
    expect(buildPushUrl('srt', i)).toBe(
      'srt://192.168.100.183:10080?streamid=#!::r=live/cam1,m=publish',
    )
    expect(buildPushUrl('webrtc', i)).toBe(
      'webrtc://192.168.100.183:1985/rtc/v1/publish/?app=live&stream=cam1',
    )
  })
  it('RTSP 无推流地址（是拉流源）返回 null', () => {
    expect(buildPushUrl('rtsp', i)).toBeNull()
  })
})

describe('buildPlayUrl', () => {
  const i = { host: '192.168.100.183', app: 'live', stream: 'cam1' }
  it('五种下行协议地址', () => {
    expect(buildPlayUrl('flv', i)).toBe('http://192.168.100.183/media/live/cam1.flv')
    expect(buildPlayUrl('hls', i)).toBe('http://192.168.100.183/media/live/cam1.m3u8')
    expect(buildPlayUrl('webrtc', i)).toBe(
      'webrtc://192.168.100.183:1985/rtc/v1/play/?app=live&stream=cam1',
    )
    expect(buildPlayUrl('rtmp', i)).toBe('rtmp://192.168.100.183:1935/live/cam1')
    expect(buildPlayUrl('srt', i)).toBe(
      'srt://192.168.100.183:10080?streamid=#!::r=live/cam1,m=request',
    )
  })
})

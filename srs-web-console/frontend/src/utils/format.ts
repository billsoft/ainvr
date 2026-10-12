/** Bitrate units must not look like a resolution label. */
export function formatBitrate(kbps?: number): string {
  if (kbps == null || kbps <= 0) return '-'
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`
  return `${Math.round(kbps)} kbps`
}

/** 时长格式化：秒 → "2天3小时" / "5小时30分" / "45分" / "30秒" */
export function formatDuration(sec?: number): string {
  if (sec == null || sec < 0) return '-'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分`
  return `${s}秒`
}

/** 字节数格式化：Bytes → 人类可读（1536 → "1.5KB"，1234567 → "1.2MB"） */
export function formatBytes(bytes?: number): string {
  if (bytes == null || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/** 相对时间：unix 秒时间戳 → "刚刚" / "3分钟前" / "2小时前" / "5天前"；
 * 超过 7 天直接给绝对日期（再往前"N天前"意义不大，不如给具体哪天） */
export function formatRelativeTime(unixSeconds?: number | null): string {
  if (unixSeconds == null) return '-'
  const diffSec = Date.now() / 1000 - unixSeconds
  if (diffSec < 0) return '刚刚'
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}天前`
  return new Date(unixSeconds * 1000).toLocaleDateString('zh-CN')
}

export interface UrlBuildInput {
  host: string
  app: string
  stream: string
}

/** 推流地址（上行；RTSP 返回 null——RTSP 是拉流源而非推流地址） */
export function buildPushUrl(
  protocol: 'rtmp' | 'srt' | 'webrtc' | 'rtsp',
  i: UrlBuildInput,
): string | null {
  switch (protocol) {
    case 'rtmp':
      return `rtmp://${i.host}:1935/${i.app}/${i.stream}`
    case 'webrtc':
      return `webrtc://${i.host}:1985/rtc/v1/publish/?app=${i.app}&stream=${i.stream}`
    case 'srt':
      return `srt://${i.host}:10080?streamid=#!::r=${i.app}/${i.stream},m=publish`
    case 'rtsp':
      return null
  }
}

/** 播放地址（下行） */
export function buildPlayUrl(
  protocol: 'flv' | 'hls' | 'webrtc' | 'rtmp' | 'srt',
  i: UrlBuildInput,
): string {
  switch (protocol) {
    case 'flv':
      return `http://${i.host}/media/${i.app}/${i.stream}.flv`
    case 'hls':
      return `http://${i.host}/media/${i.app}/${i.stream}.m3u8`
    case 'webrtc':
      return `webrtc://${i.host}:1985/rtc/v1/play/?app=${i.app}&stream=${i.stream}`
    case 'rtmp':
      return `rtmp://${i.host}:1935/${i.app}/${i.stream}`
    case 'srt':
      return `srt://${i.host}:10080?streamid=#!::r=${i.app}/${i.stream},m=request`
  }
}

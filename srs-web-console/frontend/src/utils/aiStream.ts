/**
 * 从 ai-service 算好的 effective_target_url（rtmp://host[:port]/app/stream）
 * 解出播放用的 {app, stream}——host 统一用当前浏览器访问的域名/IP
 * （跟 pages/Channels/index.tsx 里 `const host = window.location.hostname`
 * 是同一个既有约定：SRS 播放地址不看推流地址里的 host，看浏览器怎么连进来的）。
 */
export function parseRtmpToPlayTarget(rtmpUrl: string): { app: string; stream: string } | null {
  const m = /^rtmp:\/\/[^/]+\/([^/]+)\/(.+)$/.exec(rtmpUrl)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  return { app: m[1], stream: m[2] }
}

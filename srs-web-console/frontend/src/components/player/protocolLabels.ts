import type { PlayProtocol } from '@/utils/playerMachine'
export const PROTO_LABEL: Record<PlayProtocol, string> = {
  flv: 'HTTP-FLV',
  hls: 'HLS',
  webrtc: 'WebRTC',
}

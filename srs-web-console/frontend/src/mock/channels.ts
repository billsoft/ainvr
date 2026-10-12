import type { ChannelWithStatus } from '@/types/channel'

/**
 * Mock 通道数据（Phase 1-3 前端原型使用，Phase 4 切换 BFF 真实 API）
 * id 固定，保证测试稳定
 */
export const mockChannels: ChannelWithStatus[] = [
  {
    id: 'ch-001',
    name: '大门摄像头',
    description: '门口位置，24 小时值守画面',
    upstream: { protocol: 'rtmp', app: 'live', stream: 'cam_main_door' },
    downstream: { protocols: ['flv', 'hls', 'webrtc'], primary: 'flv' },
    createdAt: '2026-09-01T08:00:00+08:00',
    updatedAt: '2026-09-01T08:00:00+08:00',
    status: {
      channelId: 'ch-001',
      online: true,
      viewerCount: 3,
      bitrateKbps: 2415,
      videoCodec: 'H264',
      audioCodec: 'AAC',
      durationSec: 2 * 86400 + 3 * 3600,
    },
  },
  {
    id: 'ch-002',
    name: '后门摄像头',
    description: '货运通道',
    upstream: {
      protocol: 'rtsp',
      app: 'live',
      stream: 'cam_back_door',
      rtspUrl: 'rtsp://192.168.100.50:554/stream1',
    },
    downstream: { protocols: ['flv', 'hls'], primary: 'flv' },
    createdAt: '2026-09-01T09:30:00+08:00',
    updatedAt: '2026-09-02T14:00:00+08:00',
    status: { channelId: 'ch-002', online: false, viewerCount: 0 },
  },
  {
    id: 'ch-003',
    name: '会议室直播',
    description: '周三例会推流用',
    upstream: { protocol: 'webrtc', app: 'live', stream: 'meeting_room' },
    downstream: { protocols: ['webrtc', 'flv'], primary: 'webrtc' },
    createdAt: '2026-09-02T10:00:00+08:00',
    updatedAt: '2026-09-02T10:00:00+08:00',
    status: {
      channelId: 'ch-003',
      online: true,
      viewerCount: 5,
      bitrateKbps: 1830,
      videoCodec: 'H264',
      audioCodec: 'AAC',
      durationSec: 5400,
    },
  },
  {
    id: 'ch-004',
    name: '停车场全景',
    upstream: { protocol: 'srt', app: 'live', stream: 'parking_lot' },
    downstream: { protocols: ['flv', 'hls'], primary: 'hls' },
    createdAt: '2026-08-30T16:00:00+08:00',
    updatedAt: '2026-08-30T16:00:00+08:00',
    status: {
      channelId: 'ch-004',
      online: true,
      viewerCount: 1,
      bitrateKbps: 870,
      videoCodec: 'H264',
      audioCodec: 'AAC',
      durationSec: 356400,
    },
  },
  {
    id: 'ch-005',
    name: '前台接待',
    description: '访客登记区',
    upstream: { protocol: 'rtmp', app: 'live', stream: 'front_desk' },
    downstream: { protocols: ['flv', 'hls', 'rtmp'], primary: 'flv' },
    createdAt: '2026-08-29T11:00:00+08:00',
    updatedAt: '2026-08-29T11:00:00+08:00',
    status: { channelId: 'ch-005', online: false, viewerCount: 0 },
  },
]

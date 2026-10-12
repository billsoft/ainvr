import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { ChannelTable } from '@/pages/Channels/ChannelTable'
import type { ChannelWithStatus } from '@/types/channel'

// 通道列表"编码"列（设计 §8.4①）：SRS 实测 H.265 报 "HEVC"，必须显示成 H.265
// （旧代码按 includes('h265') 判定，永远认不出 "HEVC"）；离线显示 "-"。
function row(id: string, online: boolean, videoCodec?: string): ChannelWithStatus {
  return {
    id, name: id, description: '', createdAt: '', updatedAt: '',
    upstream: { protocol: 'rtmp', app: 'live', stream: id },
    downstream: { protocols: ['webrtc'], primary: 'webrtc' },
    status: { channelId: id, online, viewerCount: 0, videoCodec },
  }
}

describe('ChannelTable 编码列', () => {
  it('HEVC → H.265、H264 → H.264、离线 → -', () => {
    const noop = vi.fn()
    render(
      <MemoryRouter>
        <ChannelTable
          rows={[row('a', true, 'HEVC'), row('b', true, 'H264'), row('c', false, 'HEVC')]}
          pipeline={{}} host="h" onPreview={noop} onCopyPush={noop} onEdit={noop} onDelete={noop}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('columnheader', { name: '编码' })).toBeInTheDocument()
    expect(screen.getByTestId('codec-a')).toHaveTextContent('H.265')
    expect(screen.getByTestId('codec-b')).toHaveTextContent('H.264')
    expect(screen.getByTestId('codec-c')).toHaveTextContent('-')
  })
})

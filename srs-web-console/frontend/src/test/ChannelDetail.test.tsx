import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { mockChannels } from '@/mock/channels'
import type { ChannelWithStatus } from '@/types/channel'

const mockGet = vi.fn()

vi.mock('@/api/channelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/channelService')>()
  return {
    ...actual,
    channelService: {
      ...(actual.createMockChannelService([]) as object),
      get: (...args: unknown[]) => mockGet(...args),
    } as unknown as typeof actual.channelService,
  }
})

import ChannelDetailPage from '@/pages/Channels/ChannelDetail'

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ path: '/channels/:id', element: <ChannelDetailPage /> }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

describe('ChannelDetail 通道详情', () => {
  it('渲染基本信息与各协议地址', async () => {
    const ch = mockChannels[0]! as ChannelWithStatus
    mockGet.mockResolvedValueOnce(structuredClone(ch))
    renderAt('/channels/ch-001')
    expect(await screen.findByTestId('detail-name')).toHaveTextContent('大门摄像头')
    expect(screen.getByTestId('push-url')).toHaveTextContent(
      'rtmp://localhost:1935/live/cam_main_door',
    )
    expect(screen.getByTestId('play-flv')).toHaveTextContent(
      'http://localhost/media/live/cam_main_door.flv',
    )
    expect(screen.getByTestId('play-hls')).toHaveTextContent(
      'http://localhost/media/live/cam_main_door.m3u8',
    )
    expect(screen.getByTestId('play-webrtc')).toHaveTextContent(
      'webrtc://localhost:1985/rtc/v1/play/?app=live&stream=cam_main_door',
    )
  })

  it('RTSP 来源显示源地址而非推流地址', async () => {
    const ch = mockChannels[1]! as ChannelWithStatus
    mockGet.mockResolvedValueOnce(structuredClone(ch))
    renderAt('/channels/ch-002')
    expect(await screen.findByTestId('detail-name')).toHaveTextContent('后门摄像头')
    expect(screen.queryByTestId('push-url')).not.toBeInTheDocument()
    expect(screen.getByText(/RTSP 来源由系统自动拉流/)).toBeInTheDocument()
  })

  it('通道不存在显示提示', async () => {
    mockGet.mockResolvedValueOnce(null)
    renderAt('/channels/ch-999')
    expect(await screen.findByTestId('detail-missing')).toBeInTheDocument()
  })
})

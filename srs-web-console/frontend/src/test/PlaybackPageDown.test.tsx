import { render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

const { failService } = vi.hoisted(() => ({
  failService: {
    health: async () => {
      throw new Error('Network Error')
    },
    stats: async () => {
      throw new Error('Network Error')
    },
    listChannels: async () => {
      throw new Error('Network Error')
    },
    getConfig: async () => {
      throw new Error('Network Error')
    },
    listSegments: async () => [],
    playUrl: () => '',
    downloadUrl: () => '',
  },
}))

vi.mock('@/api/recordingService', () => ({
  recordingService: failService,
  createHttpRecordingService: () => failService,
  createMockRecordingService: () => failService,
}))

import PlaybackPage from '@/pages/Playback'

describe('PlaybackPage 录像微服务不可达', () => {
  it('health 失败时显示告警横幅，不展示通道数据', async () => {
    const router = createMemoryRouter(
      [
        { path: '/playback', element: <PlaybackPage /> },
        { path: '/playback/:channelId', element: <PlaybackPage /> },
      ],
      { initialEntries: ['/playback'] },
    )
    render(<RouterProvider router={router} />)
    expect(await screen.findByTestId('recorder-down-banner')).toBeInTheDocument()
    // 不降级：横幅明确提示，不自动切 mock
    expect(screen.queryByTestId('recording-timeline')).toBeNull()
  })
})

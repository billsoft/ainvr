import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { mockChannels } from '@/mock/channels'
import { request } from '@/api/httpClient'
import { useMonitorCatalog } from '@/pages/Monitor/useMonitorCatalog'

vi.mock('@/api/channelService', () => ({ channelService: { list: vi.fn(async () => [mockChannels[0]!]) } }))
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { list: vi.fn(async () => []), listStreams: vi.fn(async () => []) } }))
vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('loads GB binding identity without coupling it to source readiness', async () => {
  const binding = { input_id: mockChannels[0]!.id, device_id: 'device', channel_id: 'video' }
  vi.mocked(request).mockResolvedValue({ items: [binding] })
  const { result } = renderHook(useMonitorCatalog)
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.gbBindings).toEqual([binding])
  expect(request).toHaveBeenCalledWith('/gb28181/bindings')
})

it('does not block source playback when optional ingress metadata is unavailable', async () => {
  vi.mocked(request).mockRejectedValue(new Error('unavailable'))
  const { result } = renderHook(useMonitorCatalog)
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(result.current.allChannels[0]!.id).toBe(mockChannels[0]!.id)
  expect(result.current.gbBindings).toBeNull()
  expect(result.current.error).toContain('接入来源更新失败')
})

import { afterEach, expect, it, vi } from 'vitest'
import { createHttpRecordingService } from '@/api/recordingService'
import { request } from '@/api/httpClient'
vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(request).mockReset() })
it('restores and verifies the media cookie before acquiring playback availability', async () => {
  const order: string[] = []
  vi.mocked(request).mockImplementation(async path => { order.push(path); return undefined as never })
  const fetcher = vi.fn(async () => { order.push('cookie-check'); return new Response(null, { status: 204 }) })
  vi.stubGlobal('fetch', fetcher)
  await createHttpRecordingService().preparePlayback('one')
  expect(order).toEqual(['/auth/media-session', 'cookie-check', '/v1/recordings/one/availability'])
  expect(fetcher).toHaveBeenCalledWith('/api/auth/media-check', expect.objectContaining({ credentials: 'same-origin' }))
  expect(fetcher.mock.calls[0]?.length).toBe(2)
})
it('does not report a valid file as playable when the browser refuses the media cookie', async () => {
  vi.mocked(request).mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
  await expect(createHttpRecordingService().preparePlayback('one')).rejects.toMatchObject({ status: 401, message: expect.stringContaining('媒体登录') })
  expect(request).toHaveBeenCalledTimes(1)
})
it('keeps missing-file status separate from authentication', async () => {
  vi.mocked(request).mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410 }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  await expect(createHttpRecordingService().preparePlayback('one')).rejects.toMatchObject({ status: 410 })
})

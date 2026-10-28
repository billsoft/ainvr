import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthImage } from '@/components/common/AuthImage'
import { requestBlob } from '@/api/httpClient'
import { snapshotService } from '@/api/snapshotService'
vi.mock('@/api/httpClient', () => ({ requestBlob: vi.fn() }))
vi.mock('@/api/snapshotService', () => ({ snapshotService: { getImageBlob: vi.fn() } }))
afterEach(() => vi.restoreAllMocks())
it('uses the shared authenticated image path and explains missing evidence without hover', async () => {
  vi.mocked(requestBlob).mockResolvedValue(null)
  render(<AuthImage path="/search/query/results/result/images/frame" alt="证据图" />)
  await screen.findByText('图片未保存或已过期')
  expect(requestBlob).toHaveBeenCalledWith('/search/query/results/result/images/frame', expect.any(AbortSignal))
  expect(snapshotService.getImageBlob).not.toHaveBeenCalled()
})
it('revokes blob URLs and aborts requests on source changes and unmount', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:search-evidence')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.mocked(requestBlob).mockResolvedValue(new Blob(['test'], { type: 'image/jpeg' }))
  const view = render(<AuthImage path="/search/first" alt="第一张" />)
  await screen.findByRole('img', { name: '第一张' })
  const signal = vi.mocked(requestBlob).mock.calls.at(-1)![1]!
  view.unmount()
  expect(signal.aborted).toBe(true)
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:search-evidence'))
  expect(create).toHaveBeenCalled()
})

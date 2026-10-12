import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SnapshotLightbox } from '@/pages/RecognitionHistory/SnapshotLightbox'
import { snapshotService } from '@/api/snapshotService'
import type { SnapshotItem } from '@/types/snapshot'

const getImage = vi.hoisted(() => vi.fn())
vi.mock('@/api/httpClient', () => ({ request: vi.fn(), requestBlob: (...args: unknown[]) => getImage(...args) }))
const item: SnapshotItem = {
  image_id: 'face-1', channel_id: 'door', channel_name: '大门', timestamp: 1700000000,
  frame_pts_ns: 1000, model_name: 'yolo26x-face', task_type: 'face_detection',
  class_id: 0, class_name: 'face', confidence: .9, bbox: { x: 0, y: 0, w: 20, h: 20 },
  landmarks: null, image_width: 256, image_height: 256, enhanced: true,
}
beforeEach(() => {
  getImage.mockReset().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }))
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:variant'), revokeObjectURL: vi.fn() })
})
describe('原图与增强图', () => {
  it('默认图片保持旧接口，原图请求附带显式 variant', async () => {
    await snapshotService.getImageBlob('door', 'face-1')
    expect(getImage).toHaveBeenLastCalledWith('/ai/channels/door/snapshots/face-1/image')
    await snapshotService.getImageBlob('door', 'face-1', 'original')
    expect(getImage).toHaveBeenLastCalledWith('/ai/channels/door/snapshots/face-1/image?variant=original')
  })
  it('大图可切换并把缺失原图与增强图分开处理', async () => {
    render(<SnapshotLightbox channelId="door" item={item} onClose={vi.fn()} onDelete={vi.fn()} />)
    await waitFor(() => expect(getImage).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: '增强图' })).toHaveAttribute('aria-pressed', 'true')
    getImage.mockResolvedValueOnce(null)
    await userEvent.click(screen.getByRole('button', { name: /^原图$/ }))
    expect(await screen.findByText('原图未保存或已被淘汰')).toBeInTheDocument()
    expect(getImage).toHaveBeenLastCalledWith('/ai/channels/door/snapshots/face-1/image?variant=original')
    await userEvent.click(screen.getByRole('button', { name: '增强图' }))
    expect(await screen.findByRole('img', { name: 'face' })).toBeInTheDocument()
    expect(screen.queryByText('原图未保存或已被淘汰')).not.toBeInTheDocument()
  })
})

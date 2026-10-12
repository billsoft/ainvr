import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SnapshotGroupCard } from '@/pages/RecognitionHistory/SnapshotGroupCard'
import type { SnapshotFrameGroup } from '@/utils/snapshotGrouping'
import type { SnapshotItem } from '@/types/snapshot'

const mockGetImageBlob = vi.fn()
vi.mock('@/api/snapshotService', () => ({
  snapshotService: {
    getImageBlob: (...args: unknown[]) => mockGetImageBlob(...args),
  },
}))

function makeItem(overrides: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    image_id: 'img-1',
    channel_id: 'cam01',
    channel_name: '大门摄像头',
    frame_pts_ns: 1000,
    timestamp: 1700000000,
    model_name: 'scrfd_10g_kps',
    task_type: 'face_detection',
    class_id: 0,
    class_name: 'face',
    confidence: 0.92,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    landmarks: null,
    image_width: 20,
    image_height: 20,
    enhanced: false,
    ...overrides,
  }
}

function makeGroup(items: SnapshotItem[]): SnapshotFrameGroup {
  return {
    channel_id: 'cam01',
    frame_pts_ns: 1000,
    timestamp: items[0]?.timestamp ?? 0,
    items,
  }
}

// URL.createObjectURL 在 jsdom 里不存在，AuthImage 拿到 blob 后会调用它。
beforeEach(() => {
  mockGetImageBlob.mockReset()
  mockGetImageBlob.mockResolvedValue(new Blob(['fake'], { type: 'image/jpeg' }))
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() })
})

describe('SnapshotGroupCard —— 缩略图放大层', () => {
  it('点击缩略图打开放大层（回归：此前缩略图点击完全没有反应）', async () => {
    const group = makeGroup([makeItem()])
    render(<SnapshotGroupCard channelId="cam01" group={group} onDeleteOne={vi.fn()} />)

    expect(screen.queryByRole('dialog', { name: '识别记录大图' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('放大查看：face'))
    expect(await screen.findByRole('dialog', { name: '识别记录大图' })).toBeInTheDocument()
  })

  it('放大层里的删除按钮不依赖 hover，始终渲染——触屏设备也能点到（回归：缩略图原来的删除按钮 hidden group-hover:block 触屏摸不到）', async () => {
    const onDeleteOne = vi.fn()
    const group = makeGroup([makeItem({ image_id: 'img-7' })])
    render(<SnapshotGroupCard channelId="cam01" group={group} onDeleteOne={onDeleteOne} />)

    await userEvent.click(screen.getByLabelText('放大查看：face'))
    const deleteBtn = await screen.findByTestId('lightbox-delete')
    // 没有触发任何 hover/mouseover，直接点击就能删——验证的正是"不需要
    // hover 状态"这条属性。
    await userEvent.click(deleteBtn)
    expect(onDeleteOne).toHaveBeenCalledWith('img-7')
  })

  it('放大层里删除后自动关闭', async () => {
    const group = makeGroup([makeItem()])
    render(<SnapshotGroupCard channelId="cam01" group={group} onDeleteOne={vi.fn()} />)
    await userEvent.click(screen.getByLabelText('放大查看：face'))
    await userEvent.click(await screen.findByTestId('lightbox-delete'))
    expect(screen.queryByRole('dialog', { name: '识别记录大图' })).not.toBeInTheDocument()
  })

  it('多目标一句话摘要：给出目标个数和各自置信度', () => {
    const group = makeGroup([
      makeItem({ image_id: 'a', confidence: 0.9 }),
      makeItem({ image_id: 'b', confidence: 0.8 }),
    ])
    render(<SnapshotGroupCard channelId="cam01" group={group} onDeleteOne={vi.fn()} />)
    expect(screen.getByText('检测到 2 个目标（置信度 90%、80%）')).toBeInTheDocument()
  })

  it('enhanced=true 的记录显示"增强"角标，未增强的不显示', () => {
    const group = makeGroup([
      makeItem({ image_id: 'raw' }),
      makeItem({ image_id: 'enh', enhanced: true }),
    ])
    render(<SnapshotGroupCard channelId="cam01" group={group} onDeleteOne={vi.fn()} />)
    expect(screen.getAllByText('增强')).toHaveLength(1)
  })
})

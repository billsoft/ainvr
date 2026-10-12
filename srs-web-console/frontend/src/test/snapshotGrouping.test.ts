import { describe, expect, it } from 'vitest'
import { groupSnapshotsByFrame } from '@/utils/snapshotGrouping'
import type { SnapshotItem } from '@/types/snapshot'

function makeItem(overrides: Partial<SnapshotItem> = {}): SnapshotItem {
  return {
    image_id: 'img-default',
    channel_id: 'cam01',
    channel_name: '测试通道',
    frame_pts_ns: 1000,
    timestamp: 123.456,
    model_name: 'yolo26x-face',
    task_type: 'object_detection',
    class_id: 0,
    class_name: 'face',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    landmarks: null,
    image_width: 20,
    image_height: 20,
    enhanced: false,
    ...overrides,
  }
}

describe('groupSnapshotsByFrame', () => {
  it('空列表返回空分组', () => {
    expect(groupSnapshotsByFrame([])).toEqual([])
  })

  it('单条记录 → 一组一条', () => {
    const item = makeItem({ image_id: 'a' })
    const groups = groupSnapshotsByFrame([item])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items).toEqual([item])
  })

  it('相邻同 channel_id+frame_pts_ns 合并成一组，保持组内顺序', () => {
    const a = makeItem({ image_id: 'a', frame_pts_ns: 1000 })
    const b = makeItem({ image_id: 'b', frame_pts_ns: 1000 })
    const c = makeItem({ image_id: 'c', frame_pts_ns: 1000 })
    const groups = groupSnapshotsByFrame([a, b, c])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items.map((i) => i.image_id)).toEqual(['a', 'b', 'c'])
  })

  it('frame_pts_ns 不同 → 分成不同组，保持组顺序跟输入一致', () => {
    const a = makeItem({ image_id: 'a', frame_pts_ns: 1000 })
    const b = makeItem({ image_id: 'b', frame_pts_ns: 2000 })
    const groups = groupSnapshotsByFrame([a, b])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.frame_pts_ns).toBe(1000)
    expect(groups[1]!.frame_pts_ns).toBe(2000)
  })

  it('frame_pts_ns 相同但 channel_id 不同 → 不应该合并', () => {
    const a = makeItem({ image_id: 'a', channel_id: 'cam01', frame_pts_ns: 1000 })
    const b = makeItem({ image_id: 'b', channel_id: 'cam02', frame_pts_ns: 1000 })
    const groups = groupSnapshotsByFrame([a, b])
    expect(groups).toHaveLength(2)
  })

  it('同 channel_id+frame_pts_ns 但不相邻（中间隔着别的组）→ 不合并，各自成组', () => {
    const a1 = makeItem({ image_id: 'a1', frame_pts_ns: 1000 })
    const b = makeItem({ image_id: 'b', frame_pts_ns: 2000 })
    const a2 = makeItem({ image_id: 'a2', frame_pts_ns: 1000 })
    const groups = groupSnapshotsByFrame([a1, b, a2])
    expect(groups).toHaveLength(3)
    expect(groups[0]!.items.map((i) => i.image_id)).toEqual(['a1'])
    expect(groups[2]!.items.map((i) => i.image_id)).toEqual(['a2'])
  })

  it('组的 timestamp 取组内第一条的值', () => {
    const a = makeItem({ image_id: 'a', frame_pts_ns: 1000, timestamp: 500.5 })
    const b = makeItem({ image_id: 'b', frame_pts_ns: 1000, timestamp: 500.5 })
    const groups = groupSnapshotsByFrame([a, b])
    expect(groups[0]!.timestamp).toBe(500.5)
  })
})

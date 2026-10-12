import type { SnapshotItem } from '@/types/snapshot'

/** "这一刻识别到 N 个目标"分组——一组对应存储侧的一帧，组内是这一帧里的
 * 每一个识别框各自一条记录（阶段一存储子系统按"框"为粒度落库，不是按帧，
 * 见 snapshot_store.py 头注）。前端按帧重新聚合展示，人看的是"这一刻
 * 有几张脸"，不是零散的单条记录列表。 */
export interface SnapshotFrameGroup {
  channel_id: string
  frame_pts_ns: number
  timestamp: number
  items: SnapshotItem[]
}

/**
 * 只合并相邻的同 (channel_id, frame_pts_ns) 记录，不做全局哈希分组。
 *
 * 这是刻意的：接口按 _id 降序返回（约等于写入时间降序），属于同一帧的
 * 记录是写入线程一次 offer() 调用里连续插入的，天然相邻——只在相邻项
 * 之间比较，既是 O(n) 单趟扫描，也避免了理论上两个不相邻、pts 恰好相同
 * 的帧被错误合并成一组（几乎不会发生，但没有理由留这个口子）。
 *
 * 调用方应该把"目前为止加载过的全部记录"（跨多页累积的完整列表）整个
 * 传进来重新分组，而不是每页单独分组再拼接——最后一组跨页时前者能自然
 * 补全，后者会产生同一帧被拆成两组的重复展示。
 */
export function groupSnapshotsByFrame(items: SnapshotItem[]): SnapshotFrameGroup[] {
  const groups: SnapshotFrameGroup[] = []

  for (const item of items) {
    const last = groups[groups.length - 1]
    if (last && last.channel_id === item.channel_id && last.frame_pts_ns === item.frame_pts_ns) {
      last.items.push(item)
    } else {
      groups.push({
        channel_id: item.channel_id,
        frame_pts_ns: item.frame_pts_ns,
        timestamp: item.timestamp,
        items: [item],
      })
    }
  }

  return groups
}

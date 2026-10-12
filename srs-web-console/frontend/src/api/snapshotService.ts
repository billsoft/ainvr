import { request, requestBlob } from './httpClient'
import type { SnapshotOverview, SnapshotPage, SnapshotHeatmapResponse } from '@/types/snapshot'

/**
 * 识别历史（阶段一存储子系统）API 客户端。
 *
 * 命名刻意不带"mongodb/集合/文档"这类技术词——这一层直接对着页面文案走，
 * 用户看到的、我们代码里叫的，都是"记录/识别历史"，后端技术选型是实现
 * 细节，不应该渗到这一层的用词里。
 */
export const snapshotService = {
  getOverview(channelId: string): Promise<SnapshotOverview> {
    return request(`/ai/channels/${channelId}/snapshots/overview`)
  },

  /** filters 是"搜索"条件（时间范围 + 置信度下限），全部可选——省略等价于
   * 不过滤，跟改这个签名之前的行为完全一致。服务端过滤（不是拿到整页
   * 再前端筛），保证游标分页在过滤后依然连续、hasMore 判断依然准确。 */
  listPage(
    channelId: string, cursor: string | null, limit = 20,
    filters?: { minConfidence?: number; fromTs?: number; toTs?: number },
  ): Promise<SnapshotPage> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (cursor) params.set('cursor', cursor)
    if (filters?.minConfidence) params.set('min_confidence', String(filters.minConfidence))
    if (filters?.fromTs != null) params.set('from_ts', String(filters.fromTs))
    if (filters?.toTs != null) params.set('to_ts', String(filters.toTs))
    return request(`/ai/channels/${channelId}/snapshots?${params.toString()}`)
  },

  /** 返回 Blob 供调用方自己 createObjectURL——见 AuthImage.tsx，<img src>
   * 没法带鉴权头，图片必须手动 fetch。404（已被淘汰）时返回 null。 */
  async getImageBlob(channelId: string, imageId: string, variant: 'processed' | 'original' = 'processed'): Promise<Blob | null> {
    const suffix = variant === 'original' ? '?variant=original' : ''
    return requestBlob(`/ai/channels/${channelId}/snapshots/${imageId}/image${suffix}`)
  },

  deleteOne(channelId: string, imageId: string): Promise<{ image_id: string; deleted: boolean }> {
    return request(`/ai/channels/${channelId}/snapshots/${imageId}`, { method: 'DELETE' })
  },

  /** 识别事件时间热图：按 bucketS 秒分桶，只返回「有识别发生」的桶。
   * 回放页时间轴红条数据源——第一期不区分物体分类，只标记有无识别。 */
  heatmap(
    channelId: string,
    fromTs: number,
    toTs: number,
    bucketS = 300,
  ): Promise<SnapshotHeatmapResponse> {
    const params = new URLSearchParams({
      from_ts: String(fromTs),
      to_ts: String(toTs),
      bucket_s: String(bucketS),
    })
    return request(`/ai/channels/${channelId}/snapshots/heatmap?${params.toString()}`)
  },

  deleteRange(channelId: string, fromTs: number, toTs: number): Promise<{ deleted_count: number }> {
    const params = new URLSearchParams({ from_ts: String(fromTs), to_ts: String(toTs) })
    return request(`/ai/channels/${channelId}/snapshots?${params.toString()}`, { method: 'DELETE' })
  },

  clearAll(channelId: string): Promise<{ deleted_count: number }> {
    return request(`/ai/channels/${channelId}/snapshots`, { method: 'DELETE' })
  },
}

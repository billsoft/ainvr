/**
 * 识别历史（阶段一存储子系统）类型定义 —— 跟 aiChannel.ts 同一个约定：
 * 字段保持 snake_case 直通 ai-service 原始 JSON，不做 camelCase 映射，
 * 权威数据在 ai-service 侧，console 只是透传代理。
 *
 * 对用户展示时一律叫"识别历史/记录"，UI 文案不出现后端实际用的数据库
 * 技术名词，见 snapshotService.ts 头注。
 */

export interface SnapshotOverview {
  min_interval_ms?: number
  archive_stats?: {
    healthy?: boolean
    has_quarantined_data?: boolean
    faults?: { stage: string; message: string; duration_seconds: number }[]
    backpressured: boolean; queue_depth: number; dropped_count: number; write_error_count: number
    quarantined_bytes?: number
    delivery?: {
      accepted: number; committed: number; outstanding: number; quarantined: number; deleted: number
      oldest_wait_seconds: number; stages: Record<string, number>
    }
  }
  enabled: boolean
  /** 配置已开启但 MongoDB 暂时连不上时为 false。前端用来区分
   * 「配置关 → 未开启」和「配置开但连不上 → 连接中/连接失败」两种状态，
   * 避免把后一种情况误判成"没开"。 */
  connected: boolean
  /** 没有归档器时的原因：license_pending=服务刚启动授权未放行（自动恢复），
   * channel_deleting=通道正在删除，service_stopping=服务收尾。数据库真断开时不带此字段。 */
  reason?: 'license_pending' | 'channel_deleting' | 'service_stopping' | 'unavailable'
  /** 最近一次连接失败的错误信息（connected=false 时有值），用于调试展示。 */
  last_error: string | null
  count: number
  max_count: number
  storage_bytes: number
  earliest_timestamp: number | null
  latest_timestamp: number | null
}

export interface SnapshotBbox {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapshotLandmark {
  x: number
  y: number
}

export interface SnapshotItem {
  image_id: string
  channel_id: string
  channel_name: string
  frame_pts_ns: number
  timestamp: number
  model_name: string
  task_type: string
  class_id: number
  class_name: string
  confidence: number | null
  label_id?: string
  query_description?: string
  bbox: SnapshotBbox
  landmarks: SnapshotLandmark[] | null
  image_width: number | null
  image_height: number | null
  /** 这条记录的截图是否经人脸修复模型增强（true 时固定 256x256）。旧记录
   * 后端按 false 返回。 */
  enhanced: boolean
}

export interface SnapshotPage {
  items: SnapshotItem[]
  next_cursor: string | null
}

/** 识别事件时间热图（回放时间轴红条数据源）：一个「有识别发生」的时间桶 */
export interface SnapshotHeatmapBucket {
  /** 桶起始时间（unix 秒） */
  t: number
  /** 桶内识别事件数 */
  count: number
}

export interface SnapshotHeatmapResponse {
  enabled: boolean
  bucket_s: number
  count?: number
  buckets: SnapshotHeatmapBucket[]
}

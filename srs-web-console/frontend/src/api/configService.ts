/**
 * 统一配置中心 API（/api/v1/config/*）
 * 保存通过单一自动应用入口协调服务更新
 * 类型与后端 PgConfigStore / PublishOrchestrator 严格对齐
 */
import { request } from './httpClient'

// ===== 类型定义 =====

export interface ConfigDocument {
  id: number
  service: string
  group: string
  name: string
  config: Record<string, unknown>
  description?: string
  createdAt: string
  updatedAt: string
}

export interface ConfigVersion {
  id: number
  version: number
  status: 'draft' | 'published' | 'archived'
  publishedBy?: string
  publishedAt?: string
  changeSummary?: string
  createdAt: string
}

export interface ServiceState {
  serviceName: string
  appliedVersion?: number
  desiredVersion?: number
  // restarting：经重启助手触发了 systemctl restart，还在等服务重启后自报——
  // 短暂过渡态，服务重新拉取配置自报 applied/failed 后会被覆盖掉
  status: 'pending' | 'applied' | 'partial' | 'failed' | 'unknown' | 'restarting'
  restartRequired: boolean
  errorMessage?: string
  appliedAt?: string
  lastCheckAt?: string
}


export interface AuditLogEntry {
  id: number
  actor: string
  action: string
  service?: string
  group?: string
  configName?: string
  versionBefore?: number
  versionAfter?: number
  detail?: Record<string, unknown>
  ipAddress?: string
  createdAt: string
}

/** 导出数据格式（与后端 /v1/config/export 对齐） */
export interface ConfigExportData {
  version: number
  exportedAt: string
  documents: Array<{
    service: string
    group: string
    name: string
    config: Record<string, unknown>
    description?: string
  }>
  versions: Array<{
    version: number
    status: string
    changeSummary?: string
    publishedAt?: string
  }>
  serviceStates: ServiceState[]
}

/** 导入结果（与后端对齐：只有 imported + mode） */
export interface ImportResult {
  imported: number
  mode: string
}

/** "数据库配置"页 PG 只读展示区块——密码永不下发 */
export interface PgInfo {
  host: string
  port: string
  database: string
  user: string
  connected: boolean
}

// ===== 响应包装 =====

interface ApiResp<T> {
  code: number
  data: T
  error?: string
}

// ===== API 方法 =====

export type ConfigChange = Pick<ConfigDocument, 'service' | 'group' | 'name' | 'config' | 'description'> & { expectedUpdatedAt?: string | null }
export interface ApplyOperation {
  id: string
  status: 'running' | 'succeeded' | 'failed' | 'timeout'
  stage: string
  startedAt: number
  deadline: number
  version?: number
  services: string[]
}
export const configService = {
  async applyChanges(changes: ConfigChange[]): Promise<ApplyOperation> {
    return (await request<ApiResp<ApplyOperation>>('/v1/config/apply', {
      method: 'POST', body: JSON.stringify({ changes }), signal: AbortSignal.timeout(15000),
    })).data
  },
  async getApplyOperation(id?: string): Promise<ApplyOperation | null> {
    return (await request<ApiResp<ApplyOperation | null>>(`/v1/config/apply${id ? '?id=' + encodeURIComponent(id) : ''}`, { signal: AbortSignal.timeout(10000) })).data
  },
  // ---- 配置文档 ----

  /** 列出所有配置文档（可按 service / group 过滤） */
  async listDocuments(params?: { service?: string; group?: string }): Promise<ConfigDocument[]> {
    const qs = new URLSearchParams()
    if (params?.service) qs.set('service', params.service)
    if (params?.group) qs.set('group', params.group)
    const body = await request<ApiResp<ConfigDocument[]>>(
      `/v1/config/documents${qs.toString() ? '?' + qs.toString() : ''}`,
    )
    return body.data
  },

  /** 获取单个配置文档 */
  async getDocument(service: string, group: string, name: string): Promise<ConfigDocument> {
    const body = await request<ApiResp<ConfigDocument>>(
      `/v1/config/documents/${encodeURIComponent(service)}/${encodeURIComponent(group)}/${encodeURIComponent(name)}`,
    )
    return body.data
  },

  /** 新建/更新配置文档（upsert） */
  async upsertDocument(doc: Omit<ConfigDocument, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConfigDocument> {
    const body = await request<ApiResp<ConfigDocument>>('/v1/config/documents', {
      method: 'POST',
      body: JSON.stringify(doc),
    })
    return body.data
  },

  /** 删除配置文档 */
  async deleteDocument(service: string, group: string, name: string): Promise<boolean> {
    const body = await request<ApiResp<{ deleted: boolean }>>(
      `/v1/config/documents/${encodeURIComponent(service)}/${encodeURIComponent(group)}/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
    return body.data.deleted
  },

  // 2026-09-16 产品化收口：面向用户的"版本历史/回滚"表格已从页面整体删除，
  // 对应的 listVersions/getLatestPublishedVersion/getVersionSnapshot/
  // rollbackToVersion 这几个客户端方法在页面代码里已无调用方，一并删除
  // （后端路由同批删除，snapshot 端点除外——那条仍服务于 recorder/ai-service
  // 拉配置客户端，不受这次前端下线影响，只是不再从本文件调用）。

  // ---- 服务状态 ----

  /** 列出各服务配置应用状态 */
  async listServiceStates(): Promise<ServiceState[]> {
    const body = await request<ApiResp<ServiceState[]>>('/v1/config/service-states')
    return body.data
  },

  /** 获取单个服务状态 */
  async getServiceState(service: string): Promise<ServiceState> {
    const body = await request<ApiResp<ServiceState>>(
      `/v1/config/service-states/${encodeURIComponent(service)}`,
    )
    return body.data
  },

  /** PG 只读连接信息（"数据库配置"页用） */
  async getPgInfo(): Promise<PgInfo> {
    const body = await request<ApiResp<PgInfo>>('/v1/config/pg-info')
    return body.data
  },

  // ---- 导入 / 导出 ----

  /** 导出全部配置 */
  async exportConfig(): Promise<ConfigExportData> {
    const body = await request<ApiResp<ConfigExportData>>('/v1/config/export')
    return body.data
  },

  /** 导入配置（覆盖当前文档，不自动发布） */
  async importConfig(
    data: { documents: Array<{ service: string; group: string; name: string; config: Record<string, unknown>; description?: string }> },
    mode: 'merge' | 'overwrite' = 'merge',
  ): Promise<ImportResult> {
    const body = await request<ApiResp<ImportResult>>('/v1/config/import', {
      method: 'POST',
      body: JSON.stringify({ mode, data }),
    })
    return body.data
  },

  // ---- 审计日志 ----

  /** 列出审计日志（倒序，最新在前） */
  async listAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    const body = await request<ApiResp<AuditLogEntry[]>>(`/v1/config/audit-logs?limit=${limit}`)
    return body.data
  },

  // ---- 敏感值（secrets）----

  /** 检查某个 secret 是否已设置（不存在返回 false，不抛错） */
  async hasSecret(keyPath: string): Promise<boolean> {
    try {
      const body = await request<ApiResp<{ key: string; set: boolean; value: string }>>(
        `/v1/config/secrets/${encodeURIComponent(keyPath)}`,
      )
      return body.data.set
    } catch {
      return false
    }
  },

  /** 设置 secret（不回显明文） */
  async setSecret(keyPath: string, value: string, actor = 'admin'): Promise<void> {
    await request<ApiResp<null>>(`/v1/config/secrets/${encodeURIComponent(keyPath)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, actor }),
    })
  },

  /** 删除 secret */
  async deleteSecret(keyPath: string): Promise<boolean> {
    const body = await request<ApiResp<{ deleted: boolean }>>(
      `/v1/config/secrets/${encodeURIComponent(keyPath)}`,
      { method: 'DELETE' },
    )
    return body.data.deleted
  },
}

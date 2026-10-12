import { request } from './httpClient'
import type { LicenseErrorCode, LicenseStatus, MachineCodeInfo } from '@/types/license'
import { ACTIVATE_ERROR_TEXT } from '@/pages/License/licenseMessages'

/** 授权接口错误：保留 code 供页面做精细提示。 */
export class LicenseApiError extends Error {
  code: LicenseErrorCode | string

  constructor(code: LicenseErrorCode | string, message: string) {
    super(message)
    this.name = 'LicenseApiError'
    this.code = code
  }
}

/** 从 request() 抛出的统一错误里提取授权错误码（httpClient 把响应体
 *  里的字符串 code 挂到 err.code 上）。 */
export function toLicenseApiError(e: unknown): LicenseApiError {
  const err = e as { code?: unknown; message?: string }
  if (err && typeof err.code === 'string' && err.code.startsWith('LICENSE')) {
    return new LicenseApiError(err.code, ACTIVATE_ERROR_TEXT[err.code as LicenseErrorCode] ?? err.message ?? '授权操作失败')
  }
  return new LicenseApiError(
    'LICENSE_SERVICE_UNAVAILABLE',
    err?.message ? String(err.message) : '授权服务暂不可用',
  )
}

export interface LicensePreview {
  license_id: string
  grant_seq: number
  duration_minutes: number
  policy: 'hybrid_local'
  operation: 'replace' | 'already_active'
  current_remaining_seconds: number
}

export const licenseService = {
  remove(confirmation: string): Promise<LicenseStatus> {
    return request('/license/remove', { method: 'POST', body: JSON.stringify({ confirmation }) })
  },
  preview(key: string): Promise<LicensePreview> {
    return request('/license/preview', { method: 'POST', body: JSON.stringify({ key }) })
  },
  getMachineCode(): Promise<MachineCodeInfo> {
    return request<MachineCodeInfo>('/license/machine-code')
  },
  getStatus(force = false): Promise<LicenseStatus> {
    return request<LicenseStatus>(`/license/status${force ? '?force=1' : ''}`)
  },
  activate(key: string): Promise<LicenseStatus> {
    return request<LicenseStatus>('/license/activate', {
      method: 'POST',
      body: JSON.stringify({ key }),
    })
  },
}

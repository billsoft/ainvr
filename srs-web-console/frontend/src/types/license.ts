// 授权状态类型（字段与后端 BFF / license-service C++ JSON 对齐）。

export type LicenseStateName = 'unlicensed' | 'valid' | 'expired' | 'recovery_required' | 'storage_error' | 'clock_error'

export interface LicenseStatus {
  business_allowed?: boolean;
  business_block_reason?: string;
  state: LicenseStateName
  mode: '' | 'wall' | 'uptime' | 'hybrid_local'
  remaining_seconds?: number
  total_seconds?: number
  used_seconds?: number
  activation_wall?: number
  activation_result?: 'activated' | 'already_active'
  license_id?: string
  grant_seq?: number
  daemon_epoch?: string
  machine_code: string
  soc_model: string
  remaining_minutes: number // -1 = 无意义
  expires_min: number // unix 分钟；0 = 无固定到期点
  seq: number
  reason: string
  service_ok: boolean
  enforcer_tripped: boolean
}

export interface MachineCodeInfo {
  activation_request?: string
  installation_id?: string
  request_kind?: 'activate' | 'recover'
  machine_code: string
  fingerprint_version: string
  soc_model: string
}

// license-service / BFF 业务错误码。
export type LicenseErrorCode =
  | 'LICENSE_INVALID_KEY'
  | 'LICENSE_MACHINE_MISMATCH'
  | 'LICENSE_INSTALLATION_MISMATCH'
  | 'LICENSE_REPLAY'
  | 'LICENSE_RECOVERY_REQUIRED'
  | 'LICENSE_STORAGE_ERROR'
  | 'LICENSE_CLOCK_ERROR'
  | 'LICENSE_CONFIGURATION_ERROR'
  | 'LICENSE_CONFIRMATION_REQUIRED'
  | 'LICENSE_INTERNAL_ERROR'
  | 'LICENSE_REQUIRED'
  | 'LICENSE_SERVICE_UNAVAILABLE'
  | 'UNAUTHORIZED'

/** 授权事件（本端观察到的状态迁移/激活动作，仅本机留存） */
export interface LicenseEvent {
  at: number // epoch ms
  kind: 'state' | 'activate-ok' | 'activate-failed' | 'service-lost' | 'service-back'
  state?: LicenseStateName
  message?: string
}

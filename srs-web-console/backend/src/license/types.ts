// 授权状态类型（与 license-service C++ JSON 字段对齐）。

export type LicenseStateName = 'unlicensed' | 'valid' | 'expired' | 'tampered' | 'recovery_required' | 'storage_error' | 'clock_error';

export interface LicenseStatus {
  business_allowed?: boolean;
  business_block_reason?: string;
  state: LicenseStateName;
  mode: '' | 'wall' | 'uptime' | 'hybrid_local';
  remaining_seconds?: number
  total_seconds?: number
  used_seconds?: number
  activation_wall?: number
  activation_result?: 'activated' | 'already_active'
  license_id?: string
  grant_seq?: number
  daemon_epoch?: string
  machine_code: string;
  soc_model: string;
  remaining_minutes: number; // -1 = 无意义
  expires_min: number;       // unix 分钟；0 = 无固定到期点
  seq: number;
  reason: string;
  service_ok: boolean;
  enforcer_tripped: boolean;
}

export interface MachineCodeInfo {
  machine_code: string;
  fingerprint_version: string;
  soc_model: string;
}

// license-service 业务错误码（400/401 响应体 code 字段）。
export type LicenseErrorCode =
  | 'LICENSE_INVALID_KEY'
  | 'LICENSE_KEY_VERSION'
  | 'LICENSE_MACHINE_MISMATCH'
  | 'LICENSE_LOCKED_NEED_RESET'
  | 'LICENSE_EXPIRED_KEY'
  | 'UNAUTHORIZED';

export class LicenseServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'LicenseServiceError';
  }
}

import type { LicenseErrorCode, LicenseStateName } from '@/types/license'

/** 授权状态的中文展示（颜色类与文案分开维护，组件里按 state 取） */
export const STATE_TEXT: Record<LicenseStateName, string> = {
  valid: '已授权',
  unlicensed: '未授权',
  expired: '已到期',
  recovery_required: '需要修复授权状态',
  storage_error: '授权存储故障',
  clock_error: '内部计时故障',
}

export const STATE_BADGE_CLASS: Record<LicenseStateName, string> = {
  valid: 'bg-success-50 text-success-700',
  unlicensed: 'bg-danger-50 text-danger-700',
  expired: 'bg-warning-50 text-warning-700',
  recovery_required: 'bg-danger-50 text-danger-700',
  storage_error: 'bg-danger-50 text-danger-700',
  clock_error: 'bg-danger-50 text-danger-700',
}

export const STATE_DETAIL: Record<LicenseStateName, string> = {
  valid: '授权有效；各业务服务正在按授权状态运行或恢复。',
  unlicensed: '本机尚未录入有效注册码，请联系供应商获取授权。',
  expired: '授权已到期，功能将被限制，请续期后重新激活。',
  recovery_required: '授权状态无法可靠验证，请联系供应商修复或迁移，切勿删除状态文件。',
  storage_error: '授权状态无法可靠保存，业务已停止获得新租约。请检查磁盘空间与权限。',
  clock_error: '无法读取可靠的内部计时，修复后重启授权服务。',
}

/** reason（C++ 侧状态原因码）到中文的映射；未知码原样展示。 */
export const REASON_TEXT: Record<string, string> = {
  '': '',
  STATE_PRIMARY_MISSING: '授权主状态文件缺失，请联系供应商恢复；重新输入旧码不能修复。',
  STATE_TOO_LARGE: '授权状态文件大小异常，请联系供应商检查。',
  STATE_UNREADABLE: '无法读取授权状态，请检查文件权限与存储设备。',
  STATE_AUTH_FAILED: '授权状态完整性校验失败，请联系供应商修复。',
  STATE_MIGRATION_REQUIRED: '授权状态版本需要迁移，请联系供应商。',
  STATE_DEVICE_MISMATCH: '授权状态与本机硬件不匹配，不能复制其他设备的授权。',
  STATE_FIELDS_INVALID: '授权状态字段异常，请联系供应商修复。',
  STATE_BUDGET_INVALID: '授权计时记录异常，请联系供应商修复。',
  STATE_REVOCATION_INVALID: '授权注销记录异常，请联系供应商修复。',
  STATE_SEQUENCE_EXHAUSTED: '授权状态序号已达上限，请联系供应商处理。',
  CLOCK_REGRESSION: '内部计时状态异常，请检查系统并重启授权服务。',
  CLOCK_UNAVAILABLE: '无法读取内部计时器，请检查系统。',
  CLOCK_WALL_INVALID: '系统时间无效，请校正系统时间后重启授权服务。',
  SYSTEM_TIME_INVALID: '系统时间早于 2026 年（断电后时钟未校准），录像与 AI 已暂停；在「系统配置 › 日期和时间」校准后自动恢复。',
  BOOT_ID_UNAVAILABLE: '无法读取本次系统启动标识，请检查系统。',
  LICENSE_EXPIRED: '授权时间已用完，请录入新的注册码。',
  'state integer': '授权状态数值格式异常，请联系供应商修复。',
  'state range': '授权状态数值超出范围，请联系供应商修复。',
  'state open failed': '无法创建授权状态文件，请检查磁盘空间与权限。',
  'state write failed': '授权状态写入失败，请检查磁盘空间与存储设备。',
  'state fsync failed': '授权状态无法可靠保存，请检查存储设备。',
  'state close failed': '授权状态文件关闭失败，请检查存储设备。',
  'state rename failed': '授权状态替换失败，请检查文件权限与存储设备。',
  'state directory open failed': '无法打开授权状态目录，请检查目录权限。',
  'state directory fsync failed': '授权状态目录无法可靠保存，请检查存储设备。',
}

/** 激活/接口错误码 → 面向用户的提示。后端原始 message 作为兜底。 */
export const ACTIVATE_ERROR_TEXT: Partial<Record<LicenseErrorCode, string>> = {
  LICENSE_INVALID_KEY: '注册码格式不正确或已损坏，请核对后重新输入。',
  LICENSE_MACHINE_MISMATCH: '注册码与本机机器码不匹配（一机一码），请把本机机器码发给供应商重新签发。',
  LICENSE_REPLAY: '该注册码已使用或序号过旧，不能重新计时，请联系供应商签发新码。',
  LICENSE_RECOVERY_REQUIRED: '授权状态需要修复，请检查存储与时钟并联系供应商；不要删除授权状态文件。',
  LICENSE_STORAGE_ERROR: '授权操作未能可靠保存，请检查磁盘空间与权限后重试。',
  LICENSE_CLOCK_ERROR: '内部计时异常，请检查系统并重启授权服务后重试。',
  LICENSE_CONFIGURATION_ERROR: '授权服务连接凭据配置异常，请联系运维检查部署。',
  LICENSE_CONFIRMATION_REQUIRED: '请完整输入：删除注册密钥。',
  LICENSE_INTERNAL_ERROR: '授权接口内部错误，请联系运维检查日志。',
  LICENSE_REQUIRED: '当前没有可用授权，请查看授权状态并录入有效注册码。',
  LICENSE_SERVICE_UNAVAILABLE: '授权服务暂不可用，请确认授权服务运行后重试。',
  UNAUTHORIZED: '访问身份验证失败，请重新登录后重试。',
}

export const MODE_TEXT: Record<string, string> = {
  hybrid_local: '内部计时，系统时间仅可快进',
  wall: '旧版自然时间',
  uptime: '运行时长',
  '': '—',
}

import { request } from './httpClient';
export type PtzSourceSelector =
  | { protocol: 'onvif'; deviceId: string; videoSource: string }
  | { protocol: 'gb28181'; deviceId: string; channelId: string };
export interface CameraPtzSettings {
  enabled: boolean;
  panTilt: boolean | null;
  zoom: boolean | null;
  presets: boolean | null;
}
export interface CameraPtzDraft {
  settings: CameraPtzSettings;
  expectedRevision: number;
}
export interface PtzCapabilities {
  panTilt: boolean;
  zoom: boolean;
  presets: boolean;
  presetWrite: boolean;
  position: boolean;
  moveStatus: boolean;
  reason?: string;
}
export interface PtzInfo {
  supported: boolean;
  enabled?: boolean;
  source: { id: string; name: string };
  identity?: string;
  protocol?: 'onvif' | 'gb28181';
  capabilities?: PtzCapabilities;
  busy?: boolean;
  stopUnconfirmed?: boolean;
  reason?: string;
  guard?: { revision: number; blocked: boolean; baseline?: unknown; source_ids: string[] } | null;
}
export interface PtzPreset {
  id: string;
  name: string;
  shortcut?: number | null;
  deviceState?: string;
  available?: boolean;
  position?: unknown;
}
export interface PtzVector {
  pan: number;
  tilt: number;
  zoom: number;
}
const path = (id: string) => `/channels/${encodeURIComponent(id)}/ptz`;
const send = <T>(url: string, body: unknown, method = 'POST') =>
  request<T>(url, { method, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
export const ptzService = {
  catalog: () =>
    request<{
      items: {
        channelId: string;
        sourceId?: string;
        sourceName?: string;
        candidate: boolean;
        reason?: string;
      }[];
    }>('/ptz/catalog'),
  inspect: (id: string) => request<PtzInfo>(path(id), { signal: AbortSignal.timeout(12000) }),
  acquire: (id: string, identity: string) =>
    send<{ sessionId: string; identity: string; leaseMs: number }>(`${path(id)}/control-session`, {
      identity,
    }),
  command: (
    id: string,
    sessionId: string,
    sequence: number,
    vector: PtzVector,
    keepAlive = false,
  ) =>
    send<{ motionFinished?: boolean }>(
      `${path(id)}/control-session/${encodeURIComponent(sessionId)}`,
      { sequence, vector, keepAlive },
      'PUT',
    ),
  stop: (id: string, sessionId: string | null) =>
    send<{ stopConfirmed: boolean }>(`${path(id)}/stop`, { sessionId }),
  presets: (id: string) =>
    request<{ items: PtzPreset[]; supported: boolean; reason?: string }>(`${path(id)}/presets`, {
      signal: AbortSignal.timeout(12000),
    }),
  goto: (id: string, presetId: string, sessionId: string, sequence: number) =>
    send(`${path(id)}/presets/${encodeURIComponent(presetId)}/goto`, { sessionId, sequence }),
  save: (id: string, input: { id?: string; name: string; shortcut: number | null }) =>
    send<{ id: string }>(`${path(id)}/presets`, input),
  remove: (id: string, presetId: string) =>
    request(`${path(id)}/presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' }),
  restore: (id: string, expectedRevision: number, mode: 'position' | 'rearmed') =>
    send(`${path(id)}/restore-view`, { expectedRevision, mode }),
};
const reasons: Record<string, string> = {
  ptz_device_identity_conflict: '发现重复的摄像头设备标识，暂不能控制。请让同一摄像头的多个码流复用一个 ONVIF 设备记录。',
  ptz_timeout_unverified:
    '摄像头未提供可验证的短时停止范围，连续转动暂不可用；支持时可使用短步移动。',

  ptz_shortcut_in_use: '该快捷编号已被其他预置点使用，请选择其他编号。',
  ptz_preset_device_saved_metadata_failed:
    '摄像头已接受保存，但名称或快捷编号未保存成功。请刷新预置点后核对，避免再次新增。',
  ptz_preset_device_removed_metadata_failed:
    '摄像头已接受删除，但本地快捷入口未清理成功，请刷新后重试。',
  ptz_settings_saved_stop_unconfirmed:
    '配置已保存，但部分摄像头尚未确认停止。请检查连接并使用“停止摄像头”。',
  ptz_node_mapping_unavailable: '无法确认共享云台的全部画面，暂不允许控制。请重新读取设备能力。',
  ptz_context_expired: '云台服务已更新，请重新打开面板后操作。',
  ptz_busy: '这台摄像头正在由其他窗口控制，请稍后重试。',
  ptz_capacity_exceeded: '当前云台控制已达到并发上限。',
  ptz_source_changed: '摄像头关联已改变，请重新打开云台面板。',
  ptz_source_ambiguous: '摄像头来源关联不唯一，暂不能控制。',
  ptz_stop_unconfirmed: '停止尚未确认。请检查摄像头连接，并重试停止。',
  ptz_session_expired: '控制已停止，请重新按住方向按钮。',
  ptz_arming_pause_pending:
    '原布防已进入暂停保护，等待告警服务确认；摄像头尚未移动。处理后请核对恢复。',
  ptz_tracking_reset_pending:
    '原布防已暂停，但轨迹重置尚未完成；摄像头尚未移动。请处理后核对恢复。',
  ptz_tracking_reset_unsupported:
    '此 AI 处理器不支持不中断视频的轨迹重置，未暂停布防，也未移动摄像头。',
  ptz_arming_restore_pending: '摄像头已停止，正在等待告警服务确认布防恢复。',
  ptz_device_offline: '摄像头尚未注册或已离线。',
  ptz_not_supported: '此摄像头未提供云台控制能力。',
  ptz_view_rearming_required: '请先在各关联 AI 输出中核对并重新保存布防。',
  ptz_view_not_restored: '摄像头尚未恢复原布防视角，请继续调整或重新布防。',
  ptz_disabled: '云台控制已关闭。',
  ptz_input_disabled: '此输入通道已暂停。',
  ptz_preset_query_required: '无法确认摄像头已有预置位，请恢复连接后刷新，避免覆盖原预置位。',
  ptz_ai_unavailable: 'AI 服务暂不可用，无法核对关联和轨迹状态。',
  ptz_operation_unsupported: '摄像头不支持这项操作。',
  ptz_preset_query_unavailable: '预置位查询暂不可用；保留已保存的名称。',
  version_conflict: '配置已改变，请刷新后重试。',
};
export function ptzError(error: unknown) {
  const key = error instanceof Error ? error.message : String(error);
  return reasons[key] ?? '云台操作未完成，请检查设备连接后重试。';
}

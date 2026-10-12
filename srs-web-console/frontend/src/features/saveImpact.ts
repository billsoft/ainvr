import type { AiChannel } from '@/types/aiChannel'
import type { RecorderConfig } from '@/types/recording'
import { aiDependents } from '@/utils/channelMatching'

/**
 * 保存前影响说明：只描述"这次保存会打断/删除什么"，不做通用框架。
 * 文案如实反映服务端真实行为（docs/save-hot-update-refactor-2026-10-06.md）。
 */

type Upstream = { upstream: { app: string; stream: string } }

function names(list: AiChannel[]): string {
  return list.map((a) => `「${a.name}」`).join('、')
}

function dependentsText(ch: Upstream, aiChannels: AiChannel[], verb: string): string {
  const { sources, outputs } = aiDependents(ch, aiChannels)
  const parts: string[] = []
  if (sources.length) parts.push(`作为识别源：${names(sources)}`)
  if (outputs.length) parts.push(`作为识别输出：${names(outputs)}`)
  return parts.length ? `以下 AI 通道${verb}，不会自动修改（${parts.join('；')}）。` : ''
}

/** 删除接入通道：流媒体服务不按通道鉴权，删除不会阻止设备推流。 */
export function channelDeleteNotice(ch: Upstream, aiChannels: AiChannel[]): string {
  return [
    '删除后控制台和录像不再管理该通道，这一路录像随即停止。',
    '设备仍可向原推流地址推流，如需停止请在设备端关闭。',
    '已有录像不会立即删除，但回放页不再列出，按存储配额自动滚动清理。',
    dependentsText(ch, aiChannels, '仍使用该地址'),
    '此操作不可恢复。',
  ].filter(Boolean).join('')
}

/** 修改应用名/流名：未变化返回 null（直接保存）。 */
export function channelAddressChangeNotice(
  before: Upstream,
  after: Upstream,
  aiChannels: AiChannel[],
): string | null {
  if (before.upstream.app === after.upstream.app && before.upstream.stream === after.upstream.stream) return null
  return [
    '推流地址将改变：推流设备需改为新地址后才能继续接入，录像跟随新地址。',
    dependentsText(before, aiChannels, '仍指向旧地址，需要到 AI 通道页手动修改'),
  ].filter(Boolean).join('')
}

/** 调低识别历史保留上限会立即淘汰最旧记录：返回将被淘汰的条数。 */
export function historyTrimLoss(currentCount: number, newMax: number): number {
  return Math.max(0, Math.floor(currentCount) - Math.floor(newMax))
}

type StorageDraft = {
  kind: string
  localPath: string
  smb: { host: string; share: string; path: string; username: string; smbVersion: string; password?: string } | null
}
export type RecorderDraft = {
  storage: StorageDraft
  quota: { mode: string; percent: number; gb: number | null; onFull: string }
  files: { segmentSeconds: number }
  /** 用户本次输入了新的 NAS 密码（表单里保留的密码引用不算更换） */
  passwordChanged?: boolean
}

function storageKey(s: StorageDraft): string {
  return JSON.stringify(s.kind === 'smb' && s.smb
    ? [s.kind, s.smb.host, s.smb.share, s.smb.path, s.smb.username, s.smb.smbVersion]
    : [s.kind, s.localPath])
}

/** 录像配置保存影响；空数组表示无中断、无删除，可直接保存。 */
export function recorderSaveImpacts(before: RecorderConfig, after: RecorderDraft): string[] {
  const impacts: string[] = []
  if (storageKey(before.storage as StorageDraft) !== storageKey(after.storage) ||
      (after.storage.kind === 'smb' && after.passwordChanged === true)) {
    impacts.push('全部通道录像暂停，切换并检查存储后恢复；切换失败会退回原存储')
  } else if (after.files.segmentSeconds !== before.files.segmentSeconds) {
    impacts.push('全部通道录像重启一次（录像中断数秒）')
  }
  const lowered = after.quota.mode !== before.quota.mode
    || (after.quota.mode === 'percent' && after.quota.percent < before.quota.percent)
    || (after.quota.mode === 'gb' && before.quota.gb != null && after.quota.gb != null && after.quota.gb < before.quota.gb)
  if (lowered && after.quota.onFull === 'overwrite') impacts.push('若已用空间超过新的上限，会立即删除最旧的录像，不可恢复')
  if (after.quota.onFull === 'stop' && before.quota.onFull !== 'stop') impacts.push('存储达到上限后将停止录像，不再覆盖旧录像')
  return impacts
}

/** WiFi 连接/断开：本板与相机经无线网络通信时，切换会中断视频流。 */
export function wifiSwitchWarning(action: 'connect' | 'disconnect', pageHost: string, ifaceAddresses: string[]): string {
  const viaThis = ifaceAddresses.some((a) => a.split('/')[0] === pageHost)
  return [
    action === 'connect' ? '切换无线网络会先断开当前连接。' : '断开后该网卡不再联网。',
    '相机和本机如果经此无线网络通信，视频流会中断，录像和识别随之中断，直到网络恢复。',
    viaThis ? '你当前正通过这块网卡访问本页面，页面也会断开；新网络地址不同时需要用新地址重新打开。' : '',
  ].filter(Boolean).join('')
}

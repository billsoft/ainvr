import { describe, expect, it } from 'vitest'
import type { AiChannel } from '@/types/aiChannel'
import type { RecorderConfig } from '@/types/recording'
import {
  channelAddressChangeNotice, channelDeleteNotice, historyTrimLoss,
  recorderSaveImpacts, wifiSwitchWarning, type RecorderDraft,
} from '@/features/saveImpact'

function ai(name: string, source: string, output: string | null = null): AiChannel {
  return {
    id: name, name,
    config: { stream: { url: source }, publish: { enabled: !!output, target_url: output } },
  } as unknown as AiChannel
}
const gate = { upstream: { app: 'live', stream: 'gate' } }
const aiChannels = [
  ai('大门口识别', 'rtmp://127.0.0.1:1935/live/gate'),
  ai('小门识别', 'rtmp://192.168.1.2:1935/live/side', 'rtmp://127.0.0.1:1935/live/gate'),
  ai('无关通道', 'rtmp://127.0.0.1:1935/live/other'),
]

describe('接入通道删除/改地址影响', () => {
  it('删除说明如实：设备仍可推流、已有录像保留、列出依赖的 AI 通道', () => {
    const text = channelDeleteNotice(gate, aiChannels)
    expect(text).not.toContain('无法继续推入')
    expect(text).toContain('设备仍可向原推流地址推流')
    expect(text).toContain('已有录像不会立即删除')
    expect(text).toContain('作为识别源：「大门口识别」')
    expect(text).toContain('作为识别输出：「小门识别」')
    expect(text).not.toContain('无关通道')
  })
  it('没有依赖时不出现 AI 通道段落', () => {
    expect(channelDeleteNotice({ upstream: { app: 'live', stream: 'none' } }, aiChannels)).not.toContain('AI 通道')
  })
  it('地址未变直接保存；改流名时列出仍指向旧地址的 AI 通道', () => {
    expect(channelAddressChangeNotice(gate, { upstream: { app: 'live', stream: 'gate' } }, aiChannels)).toBeNull()
    const text = channelAddressChangeNotice(gate, { upstream: { app: 'live', stream: 'gate2' } }, aiChannels)
    expect(text).toContain('推流设备需改为新地址')
    expect(text).toContain('「大门口识别」')
  })
})

describe('识别历史淘汰条数', () => {
  it('只在新上限低于当前条数时为正', () => {
    expect(historyTrimLoss(100000, 60000)).toBe(40000)
    expect(historyTrimLoss(51, 60000)).toBe(0)
  })
})

describe('录像配置保存影响', () => {
  const before: RecorderConfig = {
    storage: { kind: 'local', localPath: '/data/rec', smb: null },
    quota: { mode: 'percent', percent: 90, gb: null, onFull: 'overwrite', minRetentionDays: null },
    files: { segmentSeconds: 60 },
  } as unknown as RecorderConfig
  const draft = (patch: Partial<RecorderDraft> = {}): RecorderDraft => ({
    storage: { kind: 'local', localPath: '/data/rec', smb: null },
    quota: { mode: 'percent', percent: 90, gb: null, onFull: 'overwrite' },
    files: { segmentSeconds: 60 },
    ...patch,
  })
  it('无变化不打扰', () => {
    expect(recorderSaveImpacts(before, draft())).toEqual([])
  })
  it('切换存储目录：全部录像暂停切换', () => {
    const r = recorderSaveImpacts(before, draft({ storage: { kind: 'local', localPath: '/mnt/new', smb: null } }))
    expect(r.join()).toContain('全部通道录像暂停')
  })
  it('只改分段时长：全部录像重启一次', () => {
    expect(recorderSaveImpacts(before, draft({ files: { segmentSeconds: 120 } })).join()).toContain('重启一次')
  })
  it('调低配额且满后覆盖：提示立即删除最旧录像；调高不提示', () => {
    expect(recorderSaveImpacts(before, draft({ quota: { mode: 'percent', percent: 80, gb: null, onFull: 'overwrite' } })).join()).toContain('立即删除最旧的录像')
    expect(recorderSaveImpacts(before, draft({ quota: { mode: 'percent', percent: 95, gb: null, onFull: 'overwrite' } }))).toEqual([])
  })
  it('NAS 存储只改配额：保留的密码引用不算更换存储', () => {
    const nasBefore = { ...before, storage: { kind: 'smb', localPath: '', smb: { host: 'nas', share: 'rec', path: '', username: 'u', passwordSet: true, smbVersion: 'auto' } } } as unknown as RecorderConfig
    const nasStorage = { kind: 'smb', localPath: '', smb: { host: 'nas', share: 'rec', path: '', username: 'u', smbVersion: 'auto', password: '${secret:recorder/smb}' } }
    expect(recorderSaveImpacts(nasBefore, draft({ storage: nasStorage, quota: { mode: 'percent', percent: 95, gb: null, onFull: 'overwrite' } }))).toEqual([])
    expect(recorderSaveImpacts(nasBefore, { ...draft({ storage: nasStorage }), passwordChanged: true }).join()).toContain('全部通道录像暂停')
  })
  it('改为满后停录：提示不再覆盖', () => {
    expect(recorderSaveImpacts(before, draft({ quota: { mode: 'percent', percent: 90, gb: null, onFull: 'stop' } })).join()).toContain('停止录像')
  })
})

describe('无线网络切换提醒', () => {
  it('说明视频流中断；经由该网卡访问时提示页面也会断开', () => {
    expect(wifiSwitchWarning('connect', '192.168.100.183', ['192.168.100.183/24'])).toContain('页面也会断开')
    const other = wifiSwitchWarning('disconnect', '10.0.0.5', ['192.168.100.183/24'])
    expect(other).toContain('视频流会中断')
    expect(other).not.toContain('页面也会断开')
  })
})

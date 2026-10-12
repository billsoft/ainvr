import { Section, Field, inputCls } from './fields'
import { IngestConfigPanel } from './IngestConfigPanel'
/**
 * 系统配置 · 流媒体配置（SRS）（2026-09-18，5分类改版）
 *
 * 一个页面写两份文档：
 * - backend/system/settings 的 srsApiHost 等顶层字段——backend 怎么连
 *   SRS（跨机部署时手动指定播放地址）。
 * - srs/system/settings 的 rtcCandidateIp——WebRTC 播放地址（候选地址）。
 *   空 = 自动：流媒体服务把浏览器打开本页时的地址作为候选地址，任何网卡、改 IP 后都
 *   自动正确（2026-10-08 实测）；填写 = 在访问地址之外额外宣告该地址，用于以名称
 *   访问或端口映射。下拉列出本机网口地址，也可手动输入。保存即热生效。
 *   原为 SRS 自己的 WebRTC candidate，
 *   唯一支持的字段（SrsConfigAdapter 只认这一个，其它字段发布时会被
 *   拒绝，见 store/srsAdapter.ts 头注）。此前这个字段挂在 backend 文档
 *   下、经 ConfigCenter 保存后其实从不生效（BackendConfigAdapter 不触达
 *   writeCandidateIp），已改成唯一挂在这里（2026-09-18 bug 修复）。
 *
 * 两份文档独立保存（各自一个"保存"按钮），不做"一次点击两份一起提交"
 * ——避免其中一份失败时另一份到底算不算保存成功这种含糊状态，让用户
 * 清楚知道具体是哪一份没存上。
 */
import { useEffect, useState } from 'react'
import { toast } from '@/store/toast'
import type { ConfigDocument } from '@/api/configService'
import { systemService } from '@/api/systemService'
import { networkService } from '@/api/networkService'
import { describeSrs } from '@/utils/capabilityText'

interface Props {
  backendDoc: ConfigDocument | undefined
  srsDoc: ConfigDocument | undefined
  onSavePartial: (
    service: string, group: string, name: string,
    overrides: Record<string, unknown>, description?: string,
  ) => Promise<void>
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}


const CANDIDATE_IP_RE = /^[a-zA-Z0-9.-]{0,253}$/
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const CUSTOM = '__custom__'

/** 本机可选的网口地址（只列 IPv4，去掉 /前缀长度；系统虚拟网卡不列） */
interface NicAddress { ip: string; label: string }

function kindLabel(kind: string): string {
  return kind === 'wifi' ? '无线网卡' : kind === 'ethernet' ? '有线网口' : '网卡'
}

export function StreamingConfigForm({ backendDoc, srsDoc, onSavePartial }: Props) {
  const backendConfig = backendDoc?.config ?? {}
  const [srsApiHost, setSrsApiHost] = useState(str(backendConfig.srsApiHost, 'srs:1985'))
  const [srsRtmpHost, setSrsRtmpHost] = useState(str(backendConfig.srsRtmpHost))
  const [srsHttpHost, setSrsHttpHost] = useState(str(backendConfig.srsHttpHost))
  const [srsRtcHost, setSrsRtcHost] = useState(str(backendConfig.srsRtcHost))
  const [srsSrtHost, setSrsSrtHost] = useState(str(backendConfig.srsSrtHost))
  const [backendDirty, setBackendDirty] = useState(false)
  const [backendSaving, setBackendSaving] = useState(false)

  const srsConfig = srsDoc?.config ?? {}
  const savedCandidate = str(srsConfig.rtcCandidateIp).trim()
  const [candidateMode, setCandidateMode] = useState<'auto' | 'fixed'>(savedCandidate ? 'fixed' : 'auto')
  const [rtcCandidateIp, setRtcCandidateIp] = useState(savedCandidate)
  const [nics, setNics] = useState<NicAddress[] | null>(null)
  const [candidateDirty, setCandidateDirty] = useState(false)
  const [candidateSaving, setCandidateSaving] = useState(false)
  const candidateValue = candidateMode === 'auto' ? '' : rtcCandidateIp.trim()
  const candidateInvalid = candidateMode === 'fixed' && (!candidateValue || !CANDIDATE_IP_RE.test(candidateValue))
  const nicChoice = nics?.some((n) => n.ip === rtcCandidateIp.trim()) ? rtcCandidateIp.trim() : CUSTOM
  /** 用名称（非 IPv4）打开本页时，自动方式拿到的是名称，流媒体服务无法据此给出可达地址 */
  const accessHost = typeof window !== 'undefined' ? window.location.hostname : ''
  const accessByName = !IPV4_RE.test(accessHost)

  useEffect(() => {
    let cancelled = false
    networkService.listInterfaces(false).then((list) => {
      if (cancelled) return
      setNics(list.filter((i) => !i.system).flatMap((i) => i.ipv4.addresses.map((a) => ({
        ip: a.split('/')[0] ?? '',
        label: `${kindLabel(i.kind)} ${i.name}${i.connected ? '' : '（未连接）'}`,
      }))).filter((n) => IPV4_RE.test(n.ip)))
    }).catch(() => { if (!cancelled) setNics([]) })
    return () => { cancelled = true }
  }, [])
  // 测试连接：读后端实时查询到的 SRS 版本与 H.265 能力（播放器判定用的是同一份数据）
  const [srsProbe, setSrsProbe] = useState<{ ok: boolean; text: string } | null>(null)
  const [probing, setProbing] = useState(false)
  async function handleProbe() {
    setProbing(true)
    try {
      const s = await systemService.getSummary()
      setSrsProbe({ ok: s.srsVersionLive !== false, text: describeSrs(s) })
    } catch (e: any) {
      setSrsProbe({ ok: false, text: `读取失败：${e.message || '未知错误'}` })
    } finally {
      setProbing(false)
    }
  }

  async function handleSaveBackend() {
    setBackendSaving(true)
    try {
      await onSavePartial('backend', 'system', 'settings', {
        srsApiHost: srsApiHost.trim(),
        srsRtmpHost: srsRtmpHost.trim(),
        srsHttpHost: srsHttpHost.trim(),
        srsRtcHost: srsRtcHost.trim(),
        srsSrtHost: srsSrtHost.trim(),
        srsVersion: str(backendConfig.srsVersion, '6.0.191'),
      })
      setBackendDirty(false)
      toast.success('连接地址已保存并应用')
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    } finally {
      setBackendSaving(false)
    }
  }

  async function handleSaveCandidate() {
    if (candidateInvalid) {
      toast.error('请选择网口地址，或填写只含字母、数字、点、短横线的地址')
      return
    }
    setCandidateSaving(true)
    try {
      await onSavePartial('srs', 'system', 'settings', {
        rtcCandidateIp: candidateValue,
      }, candidateValue ? `WebRTC 播放地址：指定 ${candidateValue}` : 'WebRTC 播放地址：自动')
      setCandidateDirty(false)
      toast.success('已保存并立即生效，新打开的播放窗口使用新地址')
    } catch (e: any) {
      toast.error(e.message || '保存失败')
    } finally {
      setCandidateSaving(false)
    }
  }

  return (
    <div className="space-y-5" data-unsaved={backendDirty || candidateDirty}>
      <IngestConfigPanel config={backendConfig} onSave={overrides => onSavePartial('backend', 'system', 'settings', overrides)} />
      <Section
        title="流媒体服务连接"
        hint="控制台连接本机流媒体服务使用，单机部署保持默认即可；填写错误会导致仪表盘无数据"
      >
        <Field label="流媒体服务地址">
          <input type="text" value={srsApiHost}
            onChange={(e) => { setSrsApiHost(e.target.value); setBackendDirty(true) }}
            className={inputCls} placeholder="127.0.0.1:1985" />
        </Field>

        <details className="rounded-base border border-line">
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-ink">
            高级：外部推流与播放地址
          </summary>
          <div className="space-y-4 border-t border-line px-4 py-4">
            <p className="text-xs text-ink-subtle">
              用于生成和复制外部连接地址，留空按当前访问地址推断。网页播放器仍使用本站代理；这些字段不会改变网页播放器的连接目标。
            </p>
            <Field label="RTMP 地址">
              <input type="text" value={srsRtmpHost}
                onChange={(e) => { setSrsRtmpHost(e.target.value); setBackendDirty(true) }}
                className={inputCls} placeholder="留空：自动推断" />
            </Field>
            <Field label="HTTP-FLV / HLS 地址">
              <input type="text" value={srsHttpHost}
                onChange={(e) => { setSrsHttpHost(e.target.value); setBackendDirty(true) }}
                className={inputCls} placeholder="留空：自动推断" />
            </Field>
            <Field label="WebRTC 地址">
              <input type="text" value={srsRtcHost}
                onChange={(e) => { setSrsRtcHost(e.target.value); setBackendDirty(true) }}
                className={inputCls} placeholder="留空：自动推断" />
            </Field>
            <Field label="SRT 地址">
              <input type="text" value={srsSrtHost}
                onChange={(e) => { setSrsSrtHost(e.target.value); setBackendDirty(true) }}
                className={inputCls} placeholder="留空：自动推断" />
            </Field>
          </div>
        </details>

        <p className="text-xs text-ink-subtle">检查当前已应用的连接；未保存的地址不会用于本次检查。</p>
        {srsProbe && (
          <div className={`rounded-base border p-3 text-xs ${srsProbe.ok ? 'border-success-200 bg-success-50 text-success-700' : 'border-danger-200 bg-danger-50 text-danger-700'}`}
            data-testid="srs-probe-result">
            {srsProbe.text}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={handleProbe} disabled={probing}
            className="rounded-base border border-line bg-surface px-4 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-surface-hover disabled:opacity-50">
            {probing ? '检查中…' : '检查当前连接'}
          </button>
          <button type="button" onClick={handleSaveBackend} disabled={backendSaving || !backendDirty}
            className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
            {backendSaving ? '保存并应用中…' : '保存并应用'}
          </button>
        </div>
      </Section>

      <Section
        title="WebRTC 播放地址"
        hint="网页里低延迟播放连接本机所用的地址。保存后立即生效，已打开的播放窗口重新打开即可"
      >
        <div className="space-y-2" role="radiogroup" aria-label="WebRTC 播放地址">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="rtc-candidate-mode" className="mt-1" checked={candidateMode === 'auto'}
              onChange={() => { setCandidateMode('auto'); setCandidateDirty(true) }} />
            <span>
              <span className="font-medium">自动（推荐）</span>
              <span className="block text-xs text-ink-subtle">
                使用浏览器打开本页面时的地址。相机或电脑走有线、无线哪块网卡、本机改了 IP，都无需设置。
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="radio" name="rtc-candidate-mode" className="mt-1" checked={candidateMode === 'fixed'}
              onChange={() => {
                setCandidateMode('fixed'); setCandidateDirty(true)
                const first = nics?.[0]
                if (!rtcCandidateIp.trim() && first) setRtcCandidateIp(first.ip)
              }} />
            <span>
              <span className="font-medium">指定地址</span>
              <span className="block text-xs text-ink-subtle">
                以名称访问本页、或经端口映射从其他网络访问时使用。用 IP 访问本页时，访问地址仍会自动加入。
              </span>
            </span>
          </label>
        </div>

        {candidateMode === 'auto' && accessByName && (
          <p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {`当前通过名称「${accessHost}」打开本页，自动方式可能无法给出可连接的地址，导致实时播放失败。请改用 IP 打开本页，或选择「指定地址」。`}
          </p>
        )}

        {candidateMode === 'fixed' && <div className="space-y-3">
          <Field label="本机网口地址">
            <select aria-label="本机网口地址" className={inputCls} value={nicChoice}
              onChange={(e) => {
                setRtcCandidateIp(e.target.value === CUSTOM ? '' : e.target.value); setCandidateDirty(true)
              }}>
              {(nics ?? []).map((n) => <option key={`${n.label}-${n.ip}`} value={n.ip}>{`${n.label} · ${n.ip}`}</option>)}
              <option value={CUSTOM}>手动输入…</option>
            </select>
          </Field>
          {nics !== null && nics.length === 0 && (
            <p className="text-xs text-ink-subtle">暂时读不到本机网口，请手动输入地址。</p>
          )}
          {nicChoice === CUSTOM && (
            <Field label="地址">
              <input type="text" aria-label="手动输入地址" value={rtcCandidateIp}
                onChange={(e) => { setRtcCandidateIp(e.target.value); setCandidateDirty(true) }}
                className={inputCls} placeholder="例如端口映射后的公网地址 203.0.113.10" />
            </Field>
          )}
          {candidateInvalid && rtcCandidateIp.trim() !== '' && (
            <p className="text-xs text-danger-600">地址只能包含字母、数字、点、短横线</p>
          )}
        </div>}

        <button type="button" aria-label="保存 WebRTC 播放地址" onClick={handleSaveCandidate} disabled={candidateSaving || !candidateDirty || candidateInvalid}
          className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
          {candidateSaving ? '保存并应用中…' : '保存并应用'}
        </button>
      </Section>
    </div>
  )
}

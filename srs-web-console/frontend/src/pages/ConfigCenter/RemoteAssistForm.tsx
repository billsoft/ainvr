/**
 * 系统配置 · 远程协助
 *
 * 与网络管理一样是直接生效的系统级操作，不走配置发布流程，也不受授权状态限制
 * （网页操作仍需控制台登录）。开关开启后长期有效（设备重启后自动恢复），只有在本页
 * 关闭才会断开；中转服务器平时只读，修改需再次输入管理员密码，开启或仍在运行时不允许修改。
 *
 * 开关意图（enabled）与连接程序实际状态（running）分开显示：任何一项查询失败都显示
 * "状态未知"，绝不默认当成已关闭。
 *
 * 已连接时再分两层：无远程连接 =「等待接入」，有远程连接 =「正在远程操作」。后者依据本机
 * 远程登录端口上来自隧道的实时连接数（每次查询现算，页面每 5 秒刷新），是设备上能准确观察到的
 * 唯一信号；中转服务器上"选为当前工作设备"不产生任何到设备的流量，设备无从得知，不显示。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LifeBuoy, Lock, PlugZap } from 'lucide-react'
import { toast } from '@/store/toast'
import { remoteAssistService, type RemoteAssistEvent, type RemoteAssistStatus } from '@/api/remoteAssistService'
import { Section, inputCls } from './fields'

type Target = 'enable' | 'disable'

const stateView: Record<RemoteAssistStatus['state'], { label: string; tone: string }> = {
  disabled: { label: '已关闭', tone: 'bg-surface-page text-ink-subtle' },
  connecting: { label: '连接中', tone: 'bg-primary-50 text-primary-600' },
  connected: { label: '已连接', tone: 'bg-success-50 text-success-700' },
  error: { label: '连接失败', tone: 'bg-danger-50 text-danger-700' },
  stopping: { label: '正在关闭', tone: 'bg-amber-50 text-amber-800' },
  unknown: { label: '状态未知', tone: 'bg-amber-50 text-amber-800' },
  suspended: { label: '云端已暂停', tone: 'bg-amber-50 text-amber-800' },
  unavailable: { label: '不可用', tone: 'bg-surface-page text-ink-subtle' },
}

const description: Record<RemoteAssistStatus['state'], string> = {
  disabled: '已关闭：外部无法远程登录本设备。',
  connecting: '已开启：正在连接中转服务器；设备重启后自动恢复连接，直到您在此关闭。',
  connected: '已开启：技术支持人员可随时远程登录本设备；设备重启后自动恢复连接，直到您在此关闭。',
  error: '已开启：暂时没有连上中转服务器，会自动重试；关闭后停止重试。',
  stopping: '已取消自动连接，但连接程序还没有停止，外部可能仍能远程登录本设备。',
  unknown: '暂时无法确认远程协助是否在运行，请不要把它当成已关闭。',
  suspended: '已开启，但供应商暂停了本设备的远程协助；您的开关保持不变，恢复后自动重新连接。',
  unavailable: '本设备暂不能使用远程协助。',
}

function eventText(e: RemoteAssistEvent): string {
  switch (e.type) {
    case 'enabled': return '开启远程协助'
    case 'disabled': return '关闭远程协助'
    case 'server_changed': return `修改中转服务器为 ${e.detail ?? ''}`
    case 'session_started': return '检测到远程连接'
    case 'session_ended': return `远程连接结束，${e.detail ?? ''}`
    default: return '其他操作'
  }
}

function since(ms: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (minutes >= 1440) return `已开启 ${Math.floor(minutes / 1440)} 天`
  if (minutes >= 60) return `已开启 ${Math.floor(minutes / 60)} 小时`
  return `已开启 ${minutes} 分钟`
}

/** 与授权页面一致：四位一组加横杠，方便客户和技术支持核对 */
const grouped = (code: string) => code.match(/.{1,4}/g)?.join('-') ?? code

const time = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

export function RemoteAssistForm() {
  const [status, setStatus] = useState<RemoteAssistStatus | null>(null)
  const [events, setEvents] = useState<RemoteAssistEvent[]>([])
  const [loadError, setLoadError] = useState('')
  /** 确认框锁定点击开关那一刻的目标；轮询改变状态也不会改变将要执行的动作 */
  const [pending, setPending] = useState<Target | null>(null)
  const [acting, setActing] = useState(false)
  const actingRef = useRef(false)
  /** 每次查询递增；晚到的旧结果丢弃，不能覆盖操作后的新状态 */
  const seq = useRef(0)
  const [editing, setEditing] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [password, setPassword] = useState('')
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const id = ++seq.current
    try {
      const next = await remoteAssistService.getStatus()
      if (id !== seq.current) return
      setStatus(next)
      setLoadError('')
    } catch (e) {
      if (id !== seq.current) return
      setLoadError(e instanceof Error ? e.message : '暂时无法读取远程协助状态')
    }
    try {
      const list = await remoteAssistService.listEvents()
      if (id === seq.current) setEvents(list)
    } catch { /* 记录读取失败不影响开关 */ }
  }, [])

  useEffect(() => {
    void load()
    // 操作进行中暂停轮询，操作完成后统一刷新一次
    const timer = window.setInterval(() => { if (!document.hidden && !actingRef.current) void load() }, 5000)
    return () => window.clearInterval(timer)
  }, [load])

  function startEdit() {
    setHost(status?.server?.host ?? '')
    setPort(status?.server ? String(status.server.port) : '443')
    setFormError('')
    setEditing(true)
  }

  async function run(target: Target) {
    actingRef.current = true
    setActing(true)
    seq.current++ // 作废操作前已发出的查询
    try {
      if (target === 'disable') { await remoteAssistService.disable(); toast.success('远程协助已关闭') }
      else { await remoteAssistService.enable(); toast.success('远程协助已开启') }
      setPending(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      await load()
      actingRef.current = false
      setActing(false)
    }
  }

  async function save() {
    const value = Number(port)
    if (!host.trim()) { setFormError('请填写中转服务器地址'); return }
    if (!/^\d+$/.test(port.trim()) || value < 1 || value > 65535) { setFormError('端口必须是 1–65535 的整数'); return }
    setSaving(true)
    setFormError('')
    try {
      await remoteAssistService.updateServer(host.trim(), value, password)
      toast.success('中转服务器已保存')
      setEditing(false)
      setPassword('')
      setTestResult(null)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function runTest() {
    setTesting(true)
    try {
      const r = await remoteAssistService.test()
      setTestResult({ ok: r.ok, text: r.ok && r.latency_ms !== null ? `${r.message}（延迟 ${r.latency_ms} 毫秒）` : r.message })
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : '检测失败' })
    } finally {
      setTesting(false)
    }
  }

  if (!status) {
    return loadError ? <p role="alert" className="ui-panel p-4 text-sm text-danger-700">{loadError}</p>
      : <p className="text-sm text-ink-subtle">加载中…</p>
  }

  /** 以连接状态为准：只有确实连着中转服务器时，连接数才代表技术支持在远程操作 */
  const operating = status.state === 'connected' && status.sessions > 0
  const view = status.state === 'connected'
    ? operating ? { label: '正在远程操作', tone: 'bg-danger-50 text-danger-700' } : { label: '已连接 · 等待接入', tone: stateView.connected.tone }
    : stateView[status.state]
  const text = status.state === 'connected'
    ? operating ? '已开启：技术支持正在远程登录本设备；设备重启后自动恢复连接，直到您在此关闭。'
      : '已开启：已连接中转服务器，等待技术支持接入。技术支持登录后这里会显示“正在远程操作”。'
    : description[status.state]
  const unavailable = status.state === 'unavailable'
  const stopped = status.enabled === false && status.running === false
  const live = status.enabled === true || status.running === true
  /** 只有确认已关闭且已停止才去开启；其余（开启、仍在运行、未知）一律走关闭，偏向安全 */
  const target: Target = stopped ? 'enable' : 'disable'
  return <div className="space-y-4">
    <Section title="远程协助" hint="开启后，技术支持人员可经中转服务器远程登录本设备排查问题；不影响本机录像与识别">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <LifeBuoy size={18} aria-hidden className="text-ink-subtle" />
            <span className={`rounded-full px-2.5 py-0.5 text-xs ${view.tone}`}>{view.label}</span>
          </div>
          <p className="mt-2 text-xs text-ink-subtle">{text}</p>
          {status.machine_code && <p className="mt-1.5 text-xs text-ink-subtle">
            <span>本机机器码</span>{' '}
            <span className="select-all font-mono text-ink">{grouped(status.machine_code)}</span>
            <span className="text-ink-faint">（技术支持据此找到本设备，请与对方核对）</span></p>}
        </div>
        <button type="button" role="switch" aria-checked={live} aria-label="远程协助开关"
          disabled={unavailable || acting} onClick={() => setPending(target)}
          className={`relative h-8 w-14 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${live ? 'bg-primary' : 'bg-line'}`}>
          <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${live ? 'left-7' : 'left-1'}`} />
        </button>
      </div>
      {status.message && (unavailable
        ? <p className="text-sm text-ink-subtle">{status.message}</p>
        : status.state === 'error'
          ? <p role="alert" className="rounded-base border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">{status.message}</p>
          : <p role="status" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{status.message}</p>)}
      {operating && <p role="status" className="rounded-base border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
        {`技术支持正在远程操作本设备（${status.sessions} 个远程连接）。如非您预期，可随时关闭远程协助，连接会立即断开。`}</p>}
      {loadError && <p className="text-xs text-danger-700">{loadError}</p>}
      {pending && <div className="rounded-base border border-line bg-surface-page p-4">
        <p className="text-sm text-ink">{pending === 'disable'
          ? '关闭后外部无法再远程登录本设备，已建立的远程连接会立即断开。'
          : '开启后，技术支持人员可以通过中转服务器远程登录本设备，查看和修改设备上的数据。开启状态会一直保持（设备重启后自动恢复），直到您在此关闭。'}</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary text-sm" disabled={acting} onClick={() => void run(pending)}>
            {pending === 'disable' ? '确认关闭' : '确认开启'}</button>
          <button type="button" className="btn-secondary text-sm" disabled={acting} onClick={() => setPending(null)}>取消</button>
        </div>
      </div>}
      {(live || status.state === 'unknown') && <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-base bg-surface-page px-3 py-2.5"><div className="text-xs text-ink-subtle">开启时间</div>
          <div className="mt-0.5 text-sm font-medium text-ink">{status.enabled_at ? `${time(status.enabled_at)} · ${since(status.enabled_at)}` : '—'}</div></div>
        <div className="rounded-base bg-surface-page px-3 py-2.5"><div className="text-xs text-ink-subtle">当前远程连接</div>
          <div className="mt-0.5 text-sm font-medium text-ink">{status.sessions ? `${status.sessions} 个` : '无'}</div>
          <div className="mt-0.5 text-[11px] text-ink-faint">按连接数统计，不代表已通过身份验证</div></div>
      </div>}
    </Section>

    <Section title="中转服务器" hint="一般出厂已配置。修改会改变设备由谁远程维护，需再次输入管理员密码">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink">服务器地址</span>
          <input aria-label="服务器地址" className={inputCls} value={editing ? host : status.server?.host ?? ''} readOnly={!editing}
            placeholder="relay.example.com"
            onChange={(e) => { setHost(e.target.value); setFormError('') }} /></label>
        <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink">端口</span>
          <input aria-label="端口" className={inputCls} inputMode="numeric" readOnly={!editing} placeholder="443"
            value={editing ? port : status.server ? String(status.server.port) : ''}
            onChange={(e) => { setPort(e.target.value); setFormError('') }} /></label>
      </div>
      {editing && <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink">管理员密码</span>
        <input aria-label="管理员密码" type="password" autoComplete="current-password" className={inputCls} value={password}
          onChange={(e) => { setPassword(e.target.value); setFormError('') }} /></label>}
      {formError && <p className="text-xs text-danger-700">{formError}</p>}
      <p className="flex items-center gap-1.5 text-xs text-ink-subtle"><Lock size={13} aria-hidden />
        {status.credentials ? '接入凭据：已写入（内容不显示）' : '接入凭据：未写入，请联系供应商'}</p>
      {testResult && <p className={`text-xs ${testResult.ok ? 'text-success-700' : 'text-danger-700'}`}>{testResult.text}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {editing ? <>
          <button type="button" className="btn-primary text-sm" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
          <button type="button" className="btn-secondary text-sm" disabled={saving}
            onClick={() => { setEditing(false); setPassword(''); setFormError('') }}>取消</button>
        </> : stopped || unavailable
          ? <button type="button" className="btn-secondary text-sm" disabled={unavailable} onClick={startEdit}>修改</button>
          : <span className="text-xs text-amber-800">{status.state === 'unknown'
            ? '暂时无法确认远程协助状态，确认已关闭后才能修改'
            : '远程协助开启或仍在运行时不能修改，请先关闭远程协助'}</span>}
        {!editing && <button type="button" className="btn-secondary flex items-center gap-1.5 text-sm"
          disabled={testing || !status.server} onClick={() => void runTest()}>
          <PlugZap size={14} aria-hidden />{testing ? '检测中…' : '检测连通性'}</button>}
      </div>
    </Section>

    <Section title="协助记录" hint="记录开关、服务器修改和远程连接活动。连接活动按连接数推断，不是人员登录审计">
      {events.length ? <ul className="divide-y divide-line text-sm">
        {events.map((e, i) => <li key={`${e.ts}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-ink">{eventText(e)}</span>
          <span className="text-xs text-ink-subtle">{e.actor === 'admin' ? '管理员 · ' : ''}{time(e.ts)}</span>
        </li>)}
      </ul> : <p className="text-sm text-ink-subtle">暂无记录</p>}
    </Section>
  </div>
}

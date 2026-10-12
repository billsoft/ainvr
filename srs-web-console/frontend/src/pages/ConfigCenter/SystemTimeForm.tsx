/**
 * 系统配置 · 日期和时间（2026-10-09）
 *
 * 板子没有时钟备用电池：断电后时钟清零，开机靠"上次保存时间"+联网对时。离线现场
 * 对不上时在这里校准：一键用电脑时间（最不容易出错），或手动输入；也可以指定现场
 * 的时间服务器（路由器、录像机等），以后每次开机自动对准。
 *
 * 授权按"系统时间只快进"计费：时间设得过晚会一次性消耗授权且无法恢复，所以与电脑
 * 时间相差超过 1 天的手动设置要二次确认并明确提示。校准后设备自动重启录像与 AI。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Laptop, Server } from 'lucide-react'
import { toast } from '@/store/toast'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { systemTimeService, SYSTEM_TIME_CHANGED_EVENT, type SystemTimeStatus } from '@/api/systemTimeService'

const MIN_VALID_MS = Date.UTC(2026, 0, 1)
const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')
function formatTime(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function toInputValue(ms: number) {
  return formatTime(ms).replace(' ', 'T')
}
function formatSpan(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
  return `${Math.round(h / 24)} 天`
}
function describeDiff(deviceMs: number, computerMs: number) {
  const diff = deviceMs - computerMs
  if (Math.abs(diff) < 2000) return '与电脑时间一致'
  return `设备比电脑${diff < 0 ? '慢' : '快'} ${formatSpan(Math.abs(diff))}`
}
function syncState(s: SystemTimeStatus): { text: string; tone: string } {
  if (!s.valid) return { text: '时间无效（早于 2026 年）：录像与 AI 已暂停，请立即校准', tone: 'border-danger-200 bg-danger-50 text-danger-800' }
  if (s.ntp_synchronized) return { text: '已与时间服务器同步', tone: 'border-success-200 bg-success-50 text-success-700' }
  if (s.manually_set) return { text: '本次开机已人工校准', tone: 'border-success-200 bg-success-50 text-success-700' }
  return { text: '开机后尚未对时（可能处于离线环境），时间可能不准确', tone: 'border-amber-200 bg-amber-50 text-amber-800' }
}

export function SystemTimeForm() {
  const [status, setStatus] = useState<SystemTimeStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 设备时间 − 电脑时间（取状态那一刻），之后两边各自按电脑时钟推进显示 */
  const offsetRef = useRef(0)
  const [, setTick] = useState(0)
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ target: 'computer' | number; warning: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [servers, setServers] = useState('')

  const apply = useCallback((s: SystemTimeStatus) => {
    offsetRef.current = s.epoch_ms - Date.now()
    setStatus(s)
  }, [])

  const load = useCallback(async () => {
    try {
      const s = await systemTimeService.get()
      apply(s)
      setServers(s.ntp_servers.join(', '))
      setManual(prev => prev || toInputValue(Date.now()))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '读取设备时间失败')
    }
  }, [apply])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const askComputer = () => {
    setError(null)
    setPending({ target: 'computer', warning: '' })
  }

  const askManual = () => {
    setError(null)
    const target = manual ? new Date(manual).getTime() : NaN
    if (!Number.isFinite(target)) {
      setManualError('请填写完整的日期和时间')
      return
    }
    if (target < MIN_VALID_MS) {
      setManualError('时间不能早于 2026-01-01')
      return
    }
    setManualError(null)
    const gap = Math.abs(target - Date.now())
    setPending({
      target,
      warning: gap > DAY_MS
        ? `所填时间与电脑时间相差 ${Math.round(gap / DAY_MS)} 天。时间设得过晚会一次性消耗授权时长且无法恢复，请确认年份、日期无误。`
        : '',
    })
  }

  const confirmSet = async () => {
    if (!pending) return
    // 用电脑时间：取点击确认那一刻，不用打开弹窗时的旧值
    const target = pending.target === 'computer' ? Date.now() : pending.target
    setBusy(true)
    setError(null)
    try {
      const r = await systemTimeService.setTime(target)
      apply(r)
      const message = r.restarted.length ? `已校准，${r.restarted.join('、')}正在重启` : '已校准'
      setResult(message)
      toast.success(message)
      window.dispatchEvent(new Event(SYSTEM_TIME_CHANGED_EVENT))
    } catch (e) {
      setError(e instanceof Error ? e.message : '校准失败')
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const saveServers = async () => {
    setError(null)
    setBusy(true)
    try {
      const list = servers.split(/[\s,，、;；]+/).map(s => s.trim()).filter(Boolean)
      const s = await systemTimeService.setNtpServers(list)
      apply(s)
      setServers(s.ntp_servers.join(', '))
      toast.success(list.length ? '时间服务器已保存' : '已恢复使用默认的互联网时间服务器')
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return <div className="ui-panel p-4 text-sm text-danger-700 sm:p-5" role="alert">{loadError}</div>
  }
  if (!status) return <p className="text-sm text-ink-subtle">加载中…</p>

  const computerNow = Date.now()
  const deviceNow = computerNow + offsetRef.current
  const state = syncState(status)

  return (
    <div className="space-y-4">
      <section className="ui-panel space-y-4 p-4 sm:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">日期和时间</h3>
          <p className="mt-1 text-xs leading-5 text-ink-subtle">
            设备没有时钟备用电池，断电后需要重新对时；能上网时开机会自动对准，离线现场请在这里校准。
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-base border border-line p-3">
            <div className="flex items-center gap-2 text-xs text-ink-subtle"><Clock size={14} aria-hidden />设备当前时间</div>
            <div className="mt-1 font-mono text-lg text-ink">{formatTime(deviceNow)}</div>
            {status.timezone && <div className="text-xs text-ink-faint">时区：{status.timezone}</div>}
          </div>
          <div className="rounded-base border border-line p-3">
            <div className="flex items-center gap-2 text-xs text-ink-subtle"><Laptop size={14} aria-hidden />电脑当前时间</div>
            <div className="mt-1 font-mono text-lg text-ink">{formatTime(computerNow)}</div>
            <div className="text-xs text-ink-faint">{describeDiff(deviceNow, computerNow)}</div>
          </div>
        </div>
        <div className={`rounded-base border p-3 text-sm ${state.tone}`}>{state.text}</div>
        {result && <div role="status" className="text-sm text-success-700">{result}</div>}
        {error && <div role="alert" className="text-sm text-danger-700">{error}</div>}
      </section>

      <section className="ui-panel space-y-3 p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-ink">校准时间</h3>
        <p className="text-xs leading-5 text-ink-subtle">校准后设备会自动重启录像服务和 AI 识别服务，中断约十几秒。</p>
        <button type="button" className="btn-primary w-full py-3 text-base sm:w-auto sm:px-6" disabled={busy}
          onClick={askComputer}>使用电脑时间校准</button>
        <div className="flex flex-wrap items-end gap-3 pt-2">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-xs text-ink-subtle">
            或手动设置
            <input type="datetime-local" step={1} aria-label="设备时间" value={manual} disabled={busy}
              onChange={e => { setManual(e.target.value); setManualError(null) }}
              className="rounded-base border border-line bg-surface px-3 py-2.5 text-base text-ink" />
          </label>
          <button type="button" className="btn-secondary py-2.5" disabled={busy} onClick={askManual}>设置时间</button>
        </div>
        {manualError && <p role="alert" className="text-sm text-danger-700">{manualError}</p>}
      </section>

      <section className="ui-panel space-y-3 p-4 sm:p-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><Server size={16} aria-hidden />时间服务器</h3>
        <p className="text-xs leading-5 text-ink-subtle">
          离线现场可填写现场路由器、录像机等提供对时服务的设备地址，设备每次开机会自动对准；留空保存则使用默认的互联网时间服务器。
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <input aria-label="时间服务器地址" value={servers} disabled={busy} placeholder="如 192.168.0.1，多个用逗号或空格分隔"
            onChange={e => setServers(e.target.value)}
            className="min-w-[240px] flex-1 rounded-base border border-line bg-surface px-3 py-2.5 text-base text-ink" />
          <button type="button" className="btn-secondary py-2.5" disabled={busy} onClick={() => void saveServers()}>保存时间服务器</button>
        </div>
      </section>

      <ConfirmDialog
        open={!!pending}
        title={pending?.target === 'computer' ? '使用电脑时间校准设备' : '手动设置设备时间'}
        content={`${pending?.target === 'computer'
          ? '将把设备时间设为电脑当前时间'
          : `将把设备时间设为 ${pending ? formatTime(pending.target as number) : ''}`}，随后自动重启录像服务和 AI 识别服务（中断约十几秒）。${pending?.warning ? ` ${pending.warning}` : ''}`}
        confirmText="确认校准"
        danger={!!pending?.warning}
        busy={busy}
        autoClose={false}
        onConfirm={() => void confirmSet()}
        onClose={() => setPending(null)}
      />
    </div>
  )
}

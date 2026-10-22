/**
 * 配置中心 · 网络管理分类（2026-09-22 从一级导航菜单挪入）
 *
 * 跟其它 5 个分类不同：本页不经 PG 草稿/发布流程，是直接调 os-helper 的
 * 实时生效 + 自动回滚模型（应用后 N 秒未确认自动还原）。视觉上对齐其它
 * 分类页（ui-panel 卡片、toast 提示），但保存语义保持自己独立，不接入
 * 顶部「发布变更」。
 *
 * 自动确认（2026-10-09）：只有本页正是经「被修改网卡」的主地址打开、且在设备进入
 * 待确认（waiting_confirm）后连续可访问 AUTO_CONFIRM_STABLE_MS，才自动确认——这时
 * "还能访问"证明的就是这张网卡的新配置可用。经别的网卡（如经 WiFi 改有线）、经出厂
 * 兜底地址（始终在线）、经远程协助或域名访问时，页面可达证明不了被改网卡正常，只提示
 * 手动确认，未确认照常到时回滚。计时与确认都绑定变更 ID：换成另一次变更重新计时，
 * 确认请求带回 ID，设备拒绝误确认另一次变更。任何一次轮询失败都重新计时。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Cable, Wifi, RefreshCw, Settings2, TriangleAlert, Lock,
  ArrowDownFromLine, ArrowUpFromLine } from 'lucide-react'
import { toast } from '@/store/toast'
import { networkService, type NetworkInterface, type PendingChange, type FallbackInfo } from '@/api/networkService'
import { IpConfigDialog } from './network/IpConfigDialog'
import { WifiDialog } from './network/WifiDialog'

const kindLabel: Record<NetworkInterface['kind'], string> = {
  ethernet: '有线网络',
  wifi: '无线网络',
  bridge: '网桥',
}

const AUTO_CONFIRM_STABLE_MS = 10_000
const PENDING_POLL_MS = 2_000

/** 本页是否正是经网卡 ifaceName 的某个主地址打开（出厂兜底地址不算：它始终在线，证明不了主地址） */
function accessedViaIface(host: string, ifaceName: string, list: NetworkInterface[], fb: FallbackInfo | null): boolean {
  const h = host.replace(/^\[|\]$/g, '')
  const target = list.find(i => i.name === ifaceName)
  if (!h || !target) return false
  return [...target.ipv4.addresses, ...target.ipv6.addresses]
    .map(a => a.split('/')[0])
    .some(a => a === h && !(fb && fb.interface === ifaceName && a === fb.address))
}

/** 变更的计时/确认键：有 ID 用 ID；旧版 os-helper 无 ID 时退回按网卡 */
const changeKey = (p: PendingChange) => p.id ?? `iface:${p.iface}`

const TypeIcon = ({ kind }: { kind: NetworkInterface['kind'] }) => {
  if (kind === 'wifi') return <Wifi size={18} aria-hidden />
  return <Cable size={18} aria-hidden />
}

/** accessHost：浏览器访问本页用的主机，默认取地址栏；测试可注入 */
export function NetworkConfigForm({ accessHost = window.location.hostname }: { accessHost?: string } = {}) {
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [fallback, setFallback] = useState<FallbackInfo | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [ipDialogIface, setIpDialogIface] = useState<string | null>(null)
  const [wifiDialogIface, setWifiDialogIface] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [acting, setActing] = useState(false)
  /** 某次变更（按 changeKey）经被改网卡连续可访问的起点；换变更、轮询失败、不经该网卡访问都清空 */
  const stableRef = useRef<{ key: string; since: number } | null>(null)
  /** 已发起自动确认的变更：同一次变更只自动确认一次，另一次变更不受影响 */
  const confirmingKeysRef = useRef(new Set<string>())
  /** 轮询回调里读最新兜底地址（state 闭包会旧） */
  const fallbackRef = useRef<FallbackInfo | null>(null)

  const observePending = useCallback((p: PendingChange | null, reachable: boolean, viaIface: boolean) => {
    if (!reachable || !viaIface || !p || p.state !== 'waiting_confirm') {
      stableRef.current = null
      return false
    }
    const key = changeKey(p)
    const now = Date.now()
    if (stableRef.current?.key !== key) stableRef.current = { key, since: now }
    return !confirmingKeysRef.current.has(key) && now - stableRef.current.since >= AUTO_CONFIRM_STABLE_MS
  }, [])

  const autoConfirm = useCallback(async (p: PendingChange) => {
    const key = changeKey(p)
    confirmingKeysRef.current.add(key)
    try {
      await networkService.confirm(p.id)
      setPending(null)
      setCountdown(null)
      stableRef.current = null
      toast.success('网络配置已自动确认：经该网卡的新地址可正常访问')
    } catch (e) {
      confirmingKeysRef.current.delete(key)
      stableRef.current = null
      toast.error(e instanceof Error ? e.message : '自动确认失败，请手动确认')
    }
  }, [])

  const load = useCallback(async () => {
    setError(null)
    let list: NetworkInterface[]
    try {
      list = await networkService.listInterfaces(showAll)
      setInterfaces(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
      setLoading(false)
      return
    }
    try {
      const fb = await networkService.getFallback()
      fallbackRef.current = fb
      setFallback(fb)
    } catch {
      // 拉取失败保留上一次的值——这只是一张信息卡，不是"功能不可用"的信号
    }
    try {
      const p = await networkService.getPending()
      setPending(p)
      setCountdown(p ? p.remaining : null)
      observePending(p, true, !!p && accessedViaIface(accessHost, p.iface, list, fallbackRef.current))
    } catch {
      stableRef.current = null
      // 待确认状态拉取失败：保留当前 pending/countdown 不动。如果这时候
      // 恰好有一次变更正等着确认，绝不能因为这一次轮询失败就让横幅消失——
      // 那正是用户最需要看到"能不能确认"的时刻。
    }
    setLoading(false)
  }, [showAll, accessHost, observePending])

  const refreshTimers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const refreshActive = useRef(false)
  useEffect(() => {
    refreshActive.current = true
    const timers = refreshTimers.current
    return () => { refreshActive.current = false; timers.forEach(clearTimeout); timers.clear() }
  }, [])
  const loadLater = useCallback((delay: number) => {
    if (!refreshActive.current) return
    const timer = setTimeout(() => {
      refreshTimers.current.delete(timer)
      if (refreshActive.current) void load()
    }, delay)
    refreshTimers.current.add(timer)
  }, [load])

  useEffect(() => { void load() }, [load])

  // 本地倒计时（每秒平滑递减）
  useEffect(() => {
    if (countdown == null || countdown <= 0) return
    const t = setInterval(() => setCountdown(c => (c == null ? null : Math.max(0, c - 1))), 1000)
    return () => clearInterval(t)
  }, [countdown])

  // 待确认期间每 2s 轮询 os-helper 的真实剩余秒数纠偏（同时用于自动确认的连续可访问判定）：
  // 本地 setInterval 会漂移，且页面可能是应用后才打开；同时靠轮询感知
  // 自动回滚/他人已确认（pending 变 null），及时收起横幅并刷新列表。
  const pendingIface = pending?.iface
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    const sync = async () => {
      let p: PendingChange | null
      try {
        p = await networkService.getPending()
      } catch {
        observePending(null, false, false)
        return // 拉取失败：保持现状，不能当成"已经没有变更了"
      }
      if (cancelled) return
      if (!p) {
        observePending(null, true, false)
        setPending(null)
        setCountdown(null)
        loadLater(1000)
        return
      }
      setPending(p)
      setCountdown(p.remaining)
      let via = false
      if (p.state === 'waiting_confirm') {
        // 每次都按最新网卡地址判断：改完的新地址可能几秒后才出现在网卡上
        try {
          const list = await networkService.listInterfaces(showAll)
          if (cancelled) return
          setInterfaces(list)
          via = accessedViaIface(accessHost, p.iface, list, fallbackRef.current)
        } catch {
          observePending(null, false, false)
          return
        }
      }
      if (observePending(p, true, via)) void autoConfirm(p)
    }
    const t = setInterval(() => void sync(), PENDING_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [pending, pendingIface, loadLater, observePending, autoConfirm, showAll, accessHost])

  const handleConfirm = async () => {
    setActing(true)
    try {
      await networkService.confirm(pending?.id)
      setPending(null)
      setCountdown(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '确认失败')
    } finally {
      setActing(false)
    }
  }

  const handleRevert = async () => {
    if (!confirm('确定要立即回滚到上一次网络配置吗？')) return
    setActing(true)
    try {
      await networkService.revert()
      setPending(null)
      setCountdown(null)
      loadLater(2000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '回滚失败')
    } finally {
      setActing(false)
    }
  }

  const handleRestoreFactory = async () => {
    if (!fallback) return
    if (!confirm(
      `确定要清空网卡 ${fallback.interface} 的主地址配置吗？\n` +
      `清空后该网卡只保留出厂兜底地址 ${fallback.address}/${fallback.prefix}，` +
      `其它网卡不受影响。若未在倒计时内确认会自动还原。`,
    )) return
    stableRef.current = null
    confirmingKeysRef.current.clear()
    setActing(true)
    try {
      const result = await networkService.applyIpConfig(fallback.interface, {
        ipv4: { method: 'disabled' },
        ipv6: { method: 'disabled' },
      })
      // 跟 handleIpApplied 同样的乐观展示原则：立即显示横幅，不等下一次
      // load() 成功回来——这次改的网卡完全可能就是当前访问用的那张。
      setPending({ iface: fallback.interface, state: 'applying', remaining: result.rollbackSeconds })
      setCountdown(result.rollbackSeconds)
      loadLater(1500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复出厂设置失败')
    } finally {
      setActing(false)
    }
  }

  const handleIpApplied = (remainingSeconds: number) => {
    // 乐观地立即显示确认横幅，不等下一次 load() 成功回来才显示——那次
    // 请求走的正是刚改过配置的这张网卡，最可能因为改错了而连不上，横幅
    // 反而会在最需要它的时候消失（真实回滚计时器在 os-helper 那边独立
    // 运行，不依赖这次乐观状态，纯粹是前端"能不能看见"的体验问题）。
    stableRef.current = null
    confirmingKeysRef.current.clear()
    setPending(prev => ({ iface: ipDialogIface ?? prev?.iface ?? '', state: 'applying', remaining: remainingSeconds }))
    setCountdown(remainingSeconds)
    setIpDialogIface(null)
    loadLater(1500)
  }

  const ipDialogCurrent = interfaces.find(i => i.name === ipDialogIface) || null
  /** 可编辑的主地址：兜底网卡上去掉只读的出厂兜底地址（两者是同一张网卡上的两个独立地址） */
  const mainV4 = (iface: NetworkInterface) => fallback?.interface === iface.name
    ? iface.ipv4.addresses.filter(a => a.split('/')[0] !== fallback.address)
    : iface.ipv4.addresses
  const pendingElsewhere = (name: string) => !!pending && pending.iface !== name
  /** 本页是否经被改网卡的主地址打开：决定横幅是"将自动确认"还是"请手动确认" */
  const autoConfirmable = !!pending && accessedViaIface(accessHost, pending.iface, interfaces, fallback)

  return (
    <div className="space-y-4">
      <section className="ui-panel flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
        <div>
          <h3 className="text-sm font-semibold text-ink">网络管理</h3>
          <p className="mt-1 text-xs leading-5 text-ink-subtle">网卡状态、IP 配置、WiFi — 系统级操作，直接生效，不走「发布变更」</p>
        </div>
        <button type="button" onClick={() => void load()} className="btn-secondary flex items-center gap-2 text-sm">
          <RefreshCw size={16} aria-hidden className={loading ? 'animate-spin' : ''} />
          刷新
        </button>
      </section>

      {/* 出厂兜底地址：只读，不在网卡列表的可编辑表单里出现。没走 provisioning
          的设备（fallback 为 null）不显示这张卡片，不是报错。 */}
      {fallback && (
        <section className="ui-panel flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="rounded-base bg-surface-page p-2 text-ink-subtle">
              <Lock size={16} aria-hidden />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">出厂兜底地址</span>
                <span className="font-mono text-sm text-ink-subtle">{fallback.address}/{fallback.prefix}</span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                    fallback.reachable ? 'bg-success-50 text-success-700' : 'bg-surface-page text-ink-faint'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${fallback.reachable ? 'bg-success-500' : 'bg-ink-faint'}`} />
                  {fallback.reachable ? '在线' : '当前不可达'}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-subtle">
                固定挂在网卡 <span className="font-mono">{fallback.interface}</span> 上，出厂配置、不可编辑——
                主地址配置错误导致失联时，可以直连这个地址救援。
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleRestoreFactory()}
            disabled={acting || pending?.iface === fallback.interface}
            title={pending?.iface === fallback.interface ? '有待确认的变更，请先确认或回滚后再操作' : undefined}
            className="btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            恢复出厂网络设置
          </button>
        </section>
      )}

      {/* 待确认变更横幅 */}
      {pending && countdown != null && (
        <div role="alert" className="flex items-start gap-3 rounded-panel border border-amber-200 bg-amber-50 p-4">
          <TriangleAlert size={20} className="mt-0.5 shrink-0 text-amber-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-amber-900">
              网络配置变更待确认
              {pending.iface && `（网卡：${pending.iface}）`}
            </p>
            {autoConfirmable ? (
              <p className="mt-1 text-sm text-amber-800">
                页面在新配置下保持正常访问约 10 秒后将自动确认，无需操作；若改完后无法访问，将在
                <span className="font-mono font-semibold"> {countdown}s </span>后自动回滚到上一次配置。
                也可以手动&ldquo;确认变更&rdquo;或&ldquo;立即回滚&rdquo;。
              </p>
            ) : (
              <p className="mt-1 text-sm text-amber-800">
                当前不是通过该网卡的地址打开本页，页面能访问不代表该网卡的新配置正常，请检查后手动&ldquo;确认变更&rdquo;；
                未确认将在<span className="font-mono font-semibold"> {countdown}s </span>后自动回滚到上一次配置。
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={handleRevert} disabled={acting} className="btn-secondary text-sm">
              立即回滚
            </button>
            <button type="button" onClick={handleConfirm} disabled={acting} className="btn-primary text-sm">
              确认变更
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-panel border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
          {error}
        </div>
      )}

      {/* 网卡列表 */}
      <section className="ui-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-sm font-semibold text-ink">
            网络接口（{interfaces.length}）
          </h3>
          <label className="flex items-center gap-2 text-xs text-ink-subtle">
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
            显示系统虚拟网卡
          </label>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-ink-subtle">加载中...</div>
        ) : interfaces.length === 0 ? (
          <div className="p-8 text-center text-sm text-ink-subtle">未检测到网络接口</div>
        ) : (
          <ul className="divide-y divide-line">
            {interfaces.map(iface => {
              // 已连接：优先 NM 的 connected；拿不到 NM 时退化为 carrier
              const online = iface.connected || iface.carrier
              const blocked = pendingElsewhere(iface.name)
              const blockedTitle = blocked ? `网卡 ${pending!.iface} 有待确认的变更，请先确认或回滚后再操作其它网卡` : undefined
              return (
                <li key={iface.name} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="rounded-base p-2 text-ink-subtle">
                        <TypeIcon kind={iface.kind} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">{iface.name}</span>
                          <span className="rounded-full bg-surface-page px-2 py-0.5 text-xs text-ink-subtle">
                            {kindLabel[iface.kind]}
                          </span>
                          {iface.system && (
                            <span className="rounded-full bg-surface-page px-2 py-0.5 text-xs text-ink-faint">
                              系统
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                              online
                                ? 'bg-success-50 text-success-700'
                                : 'bg-surface-page text-ink-subtle'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                online ? 'bg-success-500' : 'bg-ink-faint'
                              }`}
                            />
                            {online ? '已连接' : '未连接'}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-x-6 gap-y-1 text-xs text-ink-subtle sm:grid-cols-2 md:grid-cols-3">
                          {iface.mac && <div><span className="text-ink-faint">MAC </span>{iface.mac}</div>}
                          <div><span className="text-ink-faint">MTU </span>{iface.mtu ?? '—'}</div>
                          {iface.ipv4.gateway && (
                            <div className="truncate"><span className="text-ink-faint">网关 </span>{iface.ipv4.gateway}</div>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {mainV4(iface).map(ip => (
                            <span key={'v4-' + ip} className="rounded bg-surface-page px-2 py-0.5 font-mono text-xs text-ink-subtle">
                              <ArrowDownFromLine size={12} className="mr-1 inline text-success-500" aria-hidden />
                              {ip}
                            </span>
                          ))}
                          {fallback?.interface === iface.name && mainV4(iface).length === 0 && (
                            <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">主地址未设置</span>
                          )}
                          {fallback?.interface === iface.name && (
                            <span className="rounded border border-line px-2 py-0.5 font-mono text-xs text-ink-faint"
                              title="出厂配置，不可编辑；主地址配置错误导致失联时可直连这个地址救援">
                              {`兜底 ${fallback.address}/${fallback.prefix}（只读）`}
                            </span>
                          )}
                          {iface.ipv6.addresses.slice(0, 2).map(ip => (
                            <span key={'v6-' + ip} className="rounded bg-surface-page px-2 py-0.5 font-mono text-xs text-ink-subtle">
                              <ArrowUpFromLine size={12} className="mr-1 inline text-primary-500" aria-hidden />
                              {ip}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {iface.kind === 'wifi' && !iface.system && (
                        <button
                          type="button"
                          onClick={() => setWifiDialogIface(iface.name)}
                          disabled={blocked}
                          title={blockedTitle}
                          className="btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Wifi size={14} className="mr-1 inline" aria-hidden />
                          WiFi
                        </button>
                      )}
                      {/* 系统虚拟网卡（l4tbr0/usb0/docker 等）改了会失联，os-helper 也会拒，按钮不给 */}
                      {!iface.system && (
                        <button
                          type="button"
                          onClick={() => setIpDialogIface(iface.name)}
                          disabled={blocked}
                          title={blockedTitle}
                          className="btn-primary text-sm disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <Settings2 size={14} className="mr-1 inline" aria-hidden />
                          IP 配置
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {ipDialogCurrent && (
        <IpConfigDialog
          iface={ipDialogIface as string}
          current={ipDialogCurrent}
          fallback={fallback?.interface === ipDialogIface ? fallback : null}
          onClose={() => setIpDialogIface(null)}
          onApplied={handleIpApplied}
        />
      )}
      {wifiDialogIface && (
        <WifiDialog
          iface={wifiDialogIface}
          ifaceAddresses={interfaces.find(i => i.name === wifiDialogIface)?.ipv4.addresses ?? []}
          onClose={() => setWifiDialogIface(null)}
          onConnected={() => {
            setWifiDialogIface(null)
            loadLater(1500)
          }}
        />
      )}
    </div>
  )
}

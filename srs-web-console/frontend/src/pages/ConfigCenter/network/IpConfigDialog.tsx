import { useState } from 'react'
import { X, TriangleAlert } from 'lucide-react'
import type { FallbackInfo, IpConfig, IpMethod, NetworkInterface } from '@/api/networkService'
import { networkService } from '@/api/networkService'

interface Props {
  iface: string
  /** 网卡当前运行时配置，用于弹窗打开时预填充（改之前先看到基线） */
  current: NetworkInterface
  /** 这张网卡带出厂兜底地址时传入：兜底地址只读、始终保留，这里只编辑另一个主地址 */
  fallback?: FallbackInfo | null
  onClose: () => void
  onApplied: (remainingSeconds: number) => void
}

const METHODS: readonly IpMethod[] = ['auto', 'manual', 'disabled', 'link-local']

function normalizeMethod(m: string): IpMethod {
  return (METHODS as readonly string[]).includes(m) ? (m as IpMethod) : 'auto'
}

/** "192.168.1.5/24" → { address: '192.168.1.5', prefix: 27 }；无前缀时 prefix 为 null */
function splitCidr(value: string): { address: string; prefix: number | null } {
  const slash = value.lastIndexOf('/')
  if (slash < 0) return { address: value, prefix: null }
  const prefix = parseInt(value.slice(slash + 1), 10)
  return { address: value.slice(0, slash), prefix: Number.isFinite(prefix) ? prefix : null }
}

/** IPv4 前缀长度 → 点分十进制掩码（24 → 255.255.255.0）。预填充用，用户可再改。 */
function prefixToMaskV4(prefix: number | null): string {
  if (prefix == null || prefix < 0 || prefix > 32) return '255.255.255.0'
  const octets = [0, 0, 0, 0]
  let bits = prefix
  for (let i = 0; i < 4; i++) {
    const take = Math.min(8, bits)
    octets[i] = take === 0 ? 0 : (0xff << (8 - take)) & 0xff
    bits -= take
  }
  return octets.join('.')
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!/^\d+$/.test(p) || v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** 地址是否落在兜底地址所在网段（同网段会和兜底路由冲突） */
function inFallbackSubnet(ip: string, fb: FallbackInfo): boolean {
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(fb.address)
  if (a === null || b === null) return false
  const size = 2 ** (32 - fb.prefix)
  return Math.floor(a / size) === Math.floor(b / size)
}

export function IpConfigDialog({ iface, current, fallback = null, onClose, onApplied }: Props) {
  // 预填充当前配置（每个弹窗实例对应一次打开，state 初值只取一次）。兜底网卡：
  // 只读兜底地址不是"当前主地址"，不预填；后台对这张网卡强制手动模式（兜底地址
  // 只有手动模式能可靠叠加），所以也不提供自动获取。
  const mainAddrs = fallback
    ? current.ipv4.addresses.filter(a => splitCidr(a).address !== fallback.address)
    : current.ipv4.addresses
  const rawV4Method = normalizeMethod(current.ipv4.method)
  const v4Method = fallback && (rawV4Method === 'auto' || rawV4Method === 'link-local') ? 'manual' : rawV4Method
  const v4First = mainAddrs[0] ? splitCidr(mainAddrs[0]) : null
  const v6Method = normalizeMethod(current.ipv6.method)
  const v6First = current.ipv6.addresses[0] ? splitCidr(current.ipv6.addresses[0]) : null

  const [ipv4Method, setIpv4Method] = useState<IpMethod>(v4Method)
  const [ipv4Addr, setIpv4Addr] = useState(v4First?.address ?? '')
  const [ipv4Mask, setIpv4Mask] = useState(prefixToMaskV4(v4First?.prefix ?? null))
  const [ipv4Gw, setIpv4Gw] = useState(current.ipv4.gateway ?? '')
  const [ipv4Dns, setIpv4Dns] = useState(current.ipv4.dns.join(', '))
  const [ipv6Method, setIpv6Method] = useState<IpMethod>(v6Method)
  const [ipv6Addr, setIpv6Addr] = useState(v6First?.address ?? '')
  // IPv6 没有点分掩码，直接用前缀长度（os-helper nm.py 接受数字前缀）
  const [ipv6Prefix, setIpv6Prefix] = useState(String(v6First?.prefix ?? 64))
  const [ipv6Gw, setIpv6Gw] = useState(current.ipv6.gateway ?? '')
  const [ipv6Dns, setIpv6Dns] = useState(current.ipv6.dns.join(', '))
  const [rollbackText, setRollbackText] = useState('60')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  const parseDns = (s: string): string[] => s.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const rollbackSec = Number(rollbackText.trim())
    if (!/^\d+$/.test(rollbackText.trim()) || rollbackSec < 5 || rollbackSec > 300) {
      setError('自动回滚时间需为 5–300 之间的整数秒')
      return
    }
    if (fallback && ipv4Method === 'manual' && inFallbackSubnet(ipv4Addr.trim(), fallback)) {
      setError(`主地址不能使用出厂兜底地址所在网段（${fallback.address}/${fallback.prefix}），请填写其他网段的地址`)
      return
    }
    setSubmitting(true)
    try {
      const config: IpConfig = {
        ipv4: {
          method: ipv4Method,
          address: ipv4Method === 'manual' ? ipv4Addr || undefined : undefined,
          netmask: ipv4Method === 'manual' ? ipv4Mask || undefined : undefined,
          gateway: ipv4Method === 'manual' ? ipv4Gw || undefined : undefined,
          dns: ipv4Method === 'manual' && ipv4Dns ? parseDns(ipv4Dns) : undefined,
        },
        ipv6: {
          method: ipv6Method,
          address: ipv6Method === 'manual' ? ipv6Addr || undefined : undefined,
          netmask: ipv6Method === 'manual' ? ipv6Prefix || undefined : undefined,
          gateway: ipv6Method === 'manual' ? ipv6Gw || undefined : undefined,
          dns: ipv6Method === 'manual' && ipv6Dns ? parseDns(ipv6Dns) : undefined,
        },
        rollback_seconds: rollbackSec,
      }
      const result = await networkService.applyIpConfig(iface, config)
      onApplied(result.rollbackSeconds)
    } catch (e) {
      setError(e instanceof Error ? e.message : '应用失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${iface} IP 配置`}
    >
      <form onSubmit={handleSubmit} className="w-full max-w-xl rounded-panel bg-surface shadow-modal">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-base font-semibold text-ink">{iface} · IP 配置</h3>
          <button type="button" onClick={onClose} className="rounded-base p-1 text-ink-subtle hover:bg-surface-page" aria-label="关闭">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {/* 安全回滚提示 */}
          <div className="mb-4 flex gap-2 rounded-panel border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">应用后先试运行，可访问则自动确认</p>
              <p className="mt-0.5 text-xs">
                应用后页面在新配置下保持正常访问约 10 秒即自动确认；如果新配置导致无法访问设备，
                系统将在指定秒数后自动还原。
              </p>
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-panel border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">
              {error}
            </div>
          )}

          {/* IPv4 */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-ink">IPv4</h4>
            {fallback && (
              <p className="rounded-base bg-surface-page px-3 py-2 text-xs text-ink-subtle">
                {`出厂兜底地址 ${fallback.address}/${fallback.prefix} 始终保留在这张网卡上（只读），这里设置的是另一个主地址；`}
                这张网卡不支持自动获取（DHCP），请手动填写。
              </p>
            )}
            <div className="grid grid-cols-4 gap-3">
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">模式</span>
                <select
                  value={ipv4Method}
                  onChange={e => setIpv4Method(e.target.value as IpMethod)}
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  {!fallback && <option value="auto">自动 (DHCP)</option>}
                  <option value="manual">手动</option>
                  <option value="disabled">{fallback ? '不设置主地址' : '禁用'}</option>
                  {!fallback && <option value="link-local">本地链路</option>}
                </select>
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">IP 地址</span>
                <input
                  type="text"
                  value={ipv4Addr}
                  onChange={e => setIpv4Addr(e.target.value)}
                  disabled={ipv4Method !== 'manual'}
                  placeholder="192.168.1.100"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">子网掩码</span>
                <input
                  type="text"
                  value={ipv4Mask}
                  onChange={e => setIpv4Mask(e.target.value)}
                  disabled={ipv4Method !== 'manual'}
                  placeholder="255.255.255.0"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">网关</span>
                <input
                  type="text"
                  value={ipv4Gw}
                  onChange={e => setIpv4Gw(e.target.value)}
                  disabled={ipv4Method !== 'manual'}
                  placeholder="192.168.1.1"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-ink-subtle">DNS 服务器（逗号或空格分隔）</span>
              <input
                type="text"
                value={ipv4Dns}
                onChange={e => setIpv4Dns(e.target.value)}
                disabled={ipv4Method !== 'manual'}
                placeholder="8.8.8.8, 1.1.1.1"
                className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
              />
            </label>
          </div>

          <div className="my-5 border-t border-line" />

          {/* IPv6 */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-ink">IPv6</h4>
            <div className="grid grid-cols-4 gap-3">
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">模式</span>
                <select
                  value={ipv6Method}
                  onChange={e => setIpv6Method(e.target.value as IpMethod)}
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                >
                  <option value="auto">自动</option>
                  <option value="manual">手动</option>
                  <option value="disabled">禁用</option>
                  <option value="link-local">本地链路</option>
                </select>
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">IP 地址</span>
                <input
                  type="text"
                  value={ipv6Addr}
                  onChange={e => setIpv6Addr(e.target.value)}
                  disabled={ipv6Method !== 'manual'}
                  placeholder="2001:db8::1"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">前缀长度</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={ipv6Prefix}
                  onChange={e => setIpv6Prefix(e.target.value.replace(/[^0-9]/g, ''))}
                  disabled={ipv6Method !== 'manual'}
                  placeholder="64"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
              <label className="col-span-4 sm:col-span-1">
                <span className="text-xs text-ink-subtle">网关</span>
                <input
                  type="text"
                  value={ipv6Gw}
                  onChange={e => setIpv6Gw(e.target.value)}
                  disabled={ipv6Method !== 'manual'}
                  placeholder="fe80::1"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs text-ink-subtle">DNS 服务器（逗号或空格分隔）</span>
              <input
                type="text"
                value={ipv6Dns}
                onChange={e => setIpv6Dns(e.target.value)}
                disabled={ipv6Method !== 'manual'}
                placeholder="2001:4860:4860::8888"
                className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary disabled:opacity-50"
              />
            </label>
          </div>

          <div className="my-5 border-t border-line" />

          <label className="block">
            <span className="text-xs text-ink-subtle">自动回滚时间（5-300 秒）</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="自动回滚时间（秒）"
              value={rollbackText}
              onChange={e => setRollbackText(e.target.value.replace(/[^\d]/g, ''))}
              className="mt-1 w-32 rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} disabled={submitting} className="btn-secondary">
            取消
          </button>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? '应用中...' : '应用配置'}
          </button>
        </div>
      </form>
    </div>
  )
}

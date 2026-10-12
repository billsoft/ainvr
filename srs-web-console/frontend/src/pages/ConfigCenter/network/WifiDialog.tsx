import { useEffect, useState } from 'react'
import { X, Wifi, RefreshCw, Lock, Unlock, Check } from 'lucide-react'
import { networkService, type WifiAccessPoint } from '@/api/networkService'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { wifiSwitchWarning } from '@/features/saveImpact'

interface Props {
  iface: string
  /** 该网卡当前 IPv4 地址（"地址/前缀"），用于判断本页面是否经由它访问 */
  ifaceAddresses?: string[]
  onClose: () => void
  onConnected: () => void
}

/** nmcli SECURITY 列：开放网络为空串（或 --），其余是原文如 WEP / WPA2 / WPA2 WPA3 */
function isOpen(security: string): boolean {
  return !security || security === '--'
}

function securityLabel(security: string): string {
  if (isOpen(security)) return '开放'
  return security
}

/** WEP ASCII 密钥 5/13 位、HEX 10/26 位；WPA/WPA2/WPA3 要求 8-64 位 */
function passwordValid(security: string, password: string): boolean {
  if (isOpen(security)) return true
  if (security.toUpperCase().includes('WEP')) {
    return [5, 13, 10, 26].includes(password.length)
  }
  return password.length >= 8 && password.length <= 64
}

function passwordHint(security: string): string {
  if (isOpen(security)) return ''
  if (security.toUpperCase().includes('WEP')) return 'WEP 密钥：ASCII 5/13 位或 HEX 10/26 位'
  return '至少 8 位'
}

export function WifiDialog({ iface, ifaceAddresses = [], onClose, onConnected }: Props) {
  const [aps, setAps] = useState<WifiAccessPoint[]>([])
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<WifiAccessPoint | null>(null)
  const [password, setPassword] = useState('')
  const [connecting, setConnecting] = useState(false)
  // 隐藏网络：扫描列表里看不到 SSID（不广播），只能手动输入名称去连
  const [manualMode, setManualMode] = useState(false)
  const [manualSsid, setManualSsid] = useState('')
  const [manualHasPassword, setManualHasPassword] = useState(true)
  const [pendingAction, setPendingAction] = useState<'connect' | 'disconnect' | null>(null)

  const scan = async (rescan = true) => {
    setScanning(true)
    setError(null)
    try {
      const list = await networkService.scanWifi(iface, rescan)
      // 已连接的排最前，其余按信号强度降序
      setAps(list.sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal))
    } catch (e) {
      setError(e instanceof Error ? e.message : '扫描失败')
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => { void scan() }, [iface])

  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  const handleConnect = async () => {
    setConnecting(true)
    setError(null)
    try {
      if (manualMode) {
        const ssid = manualSsid.trim()
        if (!ssid) return
        await networkService.wifiConnect(iface, ssid, manualHasPassword ? (password || null) : null, true)
      } else {
        if (!selected) return
        await networkService.wifiConnect(iface, selected.ssid, isOpen(selected.security) ? null : password || null, false)
      }
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败')
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setConnecting(true)
    setError(null)
    try {
      await networkService.wifiDisconnect(iface)
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : '断开失败')
    } finally {
      setConnecting(false)
    }
  }

  const needPassword = selected ? !isOpen(selected.security) : false
  const canConnect = manualMode
    ? manualSsid.trim().length > 0 && manualSsid.trim().length <= 32
      && (!manualHasPassword || (password.length >= 8 && password.length <= 64))
    : selected ? (!needPassword || passwordValid(selected.security, password)) : false
  const hasActive = aps.some(a => a.active)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${iface} WiFi 管理`}
    >
      <div className="w-full max-w-xl rounded-panel bg-surface shadow-modal">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-base font-semibold text-ink">
            <Wifi size={18} className="mr-2 inline text-primary" aria-hidden />
            {iface} · WiFi
          </h3>
          <button type="button" onClick={onClose} className="rounded-base p-1 text-ink-subtle hover:bg-surface-page" aria-label="关闭">
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-panel border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">
              {error}
            </div>
          )}

          {!manualMode && (
            <>
              {/* 扫描控制 */}
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-ink">可用网络（{aps.length}）</span>
                <button
                  type="button"
                  onClick={() => void scan(true)}
                  disabled={scanning}
                  className="btn-secondary flex items-center gap-1 text-xs"
                >
                  <RefreshCw size={14} aria-hidden className={scanning ? 'animate-spin' : ''} />
                  {scanning ? '扫描中' : '重新扫描'}
                </button>
              </div>

              {/* AP 列表 */}
              <div className="max-h-64 overflow-y-auto rounded-panel border border-line">
                {scanning && aps.length === 0 ? (
                  <div className="p-6 text-center text-sm text-ink-subtle">正在扫描...</div>
                ) : aps.length === 0 ? (
                  <div className="p-6 text-center text-sm text-ink-subtle">未找到 WiFi 网络</div>
                ) : (
                  <ul className="divide-y divide-line">
                    {aps.map(ap => (
                      <li key={ap.bssid || ap.ssid}>
                        <button
                          type="button"
                          onClick={() => { setSelected(ap); setPassword('') }}
                          className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                            selected?.bssid === ap.bssid ? 'bg-primary-50' : 'hover:bg-surface-page'
                          }`}
                        >
                          <div className="relative">
                            <Wifi size={18} className={ap.active ? 'text-success-600' : 'text-ink-subtle'} aria-hidden />
                            {ap.active && (
                              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-success-500" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-ink">{ap.ssid || '(隐藏网络)'}</span>
                              {ap.active && (
                                <span className="inline-flex items-center gap-0.5 rounded-full bg-success-50 px-1.5 py-0.5 text-[10px] font-medium text-success-700">
                                  <Check size={10} aria-hidden />已连接
                                </span>
                              )}
                              {!isOpen(ap.security)
                                ? <Lock size={12} className="shrink-0 text-ink-subtle" aria-hidden />
                                : <Unlock size={12} className="shrink-0 text-ink-subtle" aria-hidden />}
                            </div>
                            <div className="text-xs text-ink-faint">
                              {securityLabel(ap.security)} · 信道 {ap.channel ?? '—'} · 信号 {ap.signal}%
                            </div>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* 密码输入 */}
              {selected && needPassword && (
                <div className="mt-4">
                  <label className="block text-xs text-ink-subtle">
                    密码（连接「{selected.ssid}」）
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={passwordHint(selected.security)}
                    className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                    autoFocus
                  />
                  <p className="mt-1 text-xs text-ink-faint">{passwordHint(selected.security)}</p>
                </div>
              )}

              <button
                type="button"
                onClick={() => { setManualMode(true); setSelected(null); setPassword('') }}
                className="mt-3 text-xs text-primary-600 hover:underline"
              >
                目标网络不广播 SSID？连接隐藏网络…
              </button>
            </>
          )}

          {manualMode && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ink">连接隐藏网络</span>
                <button
                  type="button"
                  onClick={() => { setManualMode(false); setManualSsid(''); setPassword('') }}
                  className="text-xs text-primary-600 hover:underline"
                >
                  从扫描列表选择
                </button>
              </div>
              <label className="block">
                <span className="text-xs text-ink-subtle">网络名称（SSID）</span>
                <input
                  type="text"
                  value={manualSsid}
                  onChange={e => setManualSsid(e.target.value)}
                  maxLength={32}
                  placeholder="隐藏网络的 SSID"
                  className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                  autoFocus
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-ink-subtle">
                <input type="checkbox" checked={manualHasPassword} onChange={e => setManualHasPassword(e.target.checked)} />
                需要密码（取消勾选表示开放网络）
              </label>
              {manualHasPassword && (
                <label className="block">
                  <span className="text-xs text-ink-subtle">密码</span>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="至少 8 位"
                    className="mt-1 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                </label>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={() => setPendingAction('disconnect')} disabled={connecting || !hasActive} className="btn-secondary">
            断开
          </button>
          <button type="button" onClick={onClose} disabled={connecting} className="btn-secondary">
            取消
          </button>
          <button
            type="button"
            onClick={() => setPendingAction('connect')}
            disabled={!canConnect || connecting}
            className="btn-primary"
          >
            {connecting ? '连接中...' : '连接'}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={pendingAction != null}
        title={pendingAction === 'disconnect' ? '确认断开无线网络' : '确认切换无线网络'}
        content={pendingAction ? wifiSwitchWarning(pendingAction, window.location.hostname, ifaceAddresses) : ''}
        confirmText={pendingAction === 'disconnect' ? '确认断开' : '确认连接'}
        danger
        onConfirm={() => {
          const action = pendingAction
          setPendingAction(null)
          void (action === 'disconnect' ? handleDisconnect() : handleConnect())
        }}
        onClose={() => setPendingAction(null)}
      />
    </div>
  )
}

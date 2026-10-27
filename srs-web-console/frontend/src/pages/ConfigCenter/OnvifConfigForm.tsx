import { useEffect, useState } from 'react'
import {PtzGlobalSettings} from './PtzGlobalSettings'
import { Link } from 'react-router-dom'
import { onvifService, type OnvifSettingsResponse } from '@/api/onvifService'
import { networkService, type NetworkInterface } from '@/api/networkService'

const input = 'mt-1 min-h-11 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm'
const statuses: Record<string, string> = {
  running: '已应用，可接入设备',
  disabled: '已停用',
  waiting_configuration: '等待部署配置',
  unavailable: '未连接或应用失败',
  loading: '正在检查',
}
export function OnvifConfigForm() {
  const [data, setData] = useState<OnvifSettingsResponse | null>(null),
    [status, setStatus] = useState<{ state: string; appliedRevision?: number }>({
      state: 'loading',
    })
  const [token, setToken] = useState(''),
    [networks, setNetworks] = useState(''),
    [nics, setNics] = useState<NetworkInterface[]>([]),
    [nicError, setNicError] = useState(false)
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    void onvifService
      .settings()
      .then((r) => {
        if (active) {
          setData(r)
          setNetworks(r.settings.allowedCIDRs.join('\n'))
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    void networkService
      .listInterfaces(false)
      .then((items) => {
        if (active) setNics(items.filter((n) => !n.system))
      })
      .catch(() => {
        if (active) setNicError(true)
      })
    const poll = async () => {
      try {
        const r = await onvifService.status()
        if (active) setStatus(r)
      } catch {
        if (active) setStatus({ state: 'unavailable' })
      }
      if (active) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [dirty])
  function toggle(name: string) {
    if (!data) return
    const values = data.settings.interfaces
    setData({
      ...data,
      settings: {
        ...data.settings,
        interfaces: values.includes(name) ? values.filter((v) => v !== name) : [...values, name],
      },
    })
    setDirty(true)
  }
  async function save() {
    if (!data || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const settings = { ...data.settings, allowedCIDRs: networks.split(/[\s,]+/).filter(Boolean) }
      const result = await onvifService.saveSettings({
        settings,
        expectedRevision: data.revision,
        ...(token ? { token } : {}),
      })
      setData({ settings, revision: result.revision, tokenSet: data.tokenSet || !!token })
      setToken('')
      setDirty(false)
      setMessage('配置已保存，正在等待服务确认应用。')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const applied = data && status.appliedRevision === data.revision
  const names = [...new Set([...nics.map((n) => n.name), ...(data?.settings.interfaces ?? [])])]
  return (
    <>
    <section
      className="ui-panel space-y-5 p-5"
      data-unsaved={dirty}
      onChange={() => setDirty(true)}
    >
      <div>
        <h2 className="text-lg font-semibold">ONVIF 接入</h2>
        <p className="mt-2 text-sm text-ink-subtle">
          统一配置服务和摄像头网络。设备账号、物理画面和码流在“接入管理 → 新建通道 → ONVIF”中选择。
        </p>
      </div>
      <div className="rounded-base border border-line bg-surface-page p-3 text-sm" role="status">
        {statuses[status.state] ?? '等待应用'}
        {data ? ` · 保存版本 ${data.revision}` : ''}
        {status.appliedRevision ? ` · 已应用版本 ${status.appliedRevision}` : ''}
        {message && (
          <p className="mt-1 text-ink-subtle">{applied ? '本次配置已生效。' : message}</p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {data && (
        <fieldset disabled={busy} className="space-y-5">
          <label className="flex min-h-11 items-center gap-3 font-medium">
            <input
              type="checkbox"
              checked={data.settings.enabled}
              onChange={(e) =>
                setData({ ...data, settings: { ...data.settings, enabled: e.target.checked } })
              }
            />
            启用 ONVIF 摄像头接入
          </label>
          <div>
            <h3 className="text-sm font-medium">发现摄像头的网卡</h3>
            <p className="mt-1 text-xs text-ink-subtle">
              仅在所选网卡发送发现请求；跨网段可在通道向导手动添加。
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {names.map((name) => {
                const nic = nics.find((n) => n.name === name),
                  selected = data.settings.interfaces.includes(name)
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggle(name)}
                    className={`min-h-14 rounded-base border px-3 py-2 text-left text-sm ${selected ? 'border-primary bg-primary/5 text-primary' : 'border-line bg-surface hover:border-primary'}`}
                  >
                    <span className="font-medium">
                      {selected ? '✓ ' : ''}
                      {name}
                    </span>
                    <span className="mt-1 block text-xs text-ink-subtle">
                      {nic
                        ? `${nic.ipv4.addresses.join('、') || '无 IPv4 地址'} · ${nic.connected ? '已连接' : '未连接'}`
                        : '已保存，当前未检测到此网卡'}
                    </span>
                  </button>
                )
              })}
            </div>
            {!names.length && (
              <p className="mt-2 text-sm text-ink-subtle">
                {nicError
                  ? '无法读取网卡，请检查网络管理服务；手动地址接入仍可配置。'
                  : '未检测到可用于发现的网卡。'}
              </p>
            )}
          </div>
          <label className="block text-sm font-medium">
            允许访问的摄像头网段
            <textarea
              className={input}
              rows={3}
              value={networks}
              placeholder="例如 192.168.100.0/24，每行一个网段"
              onChange={(e) => setNetworks(e.target.value)}
            />
            <span className="mt-1 block text-xs font-normal text-ink-subtle">
              启用前必须填写。设备返回的控制和媒体地址也受此范围约束。
            </span>
          </label>
          <details className="rounded-base border border-line p-3">
            <summary className="cursor-pointer text-sm font-medium">高级服务连接</summary>
            <div className="mt-3 space-y-3">
              <label className="block text-sm">
                控制服务地址
                <input
                  className={input}
                  value={data.settings.serviceUrl}
                  onChange={(e) =>
                    setData({ ...data, settings: { ...data.settings, serviceUrl: e.target.value } })
                  }
                />
              </label>
              <label className="block text-sm">
                服务连接密钥
                <input
                  type="password"
                  autoComplete="new-password"
                  className={input}
                  value={token}
                  placeholder={data.tokenSet ? '已设置，留空保持' : '由部署程序生成'}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                设备请求超时（1–15 秒）
                <input
                  type="number"
                  min={1}
                  max={15}
                  className={input}
                  value={data.settings.timeoutSeconds}
                  onChange={(e) =>
                    setData({
                      ...data,
                      settings: { ...data.settings, timeoutSeconds: Number(e.target.value) },
                    })
                  }
                />
              </label>
            </div>
          </details>
          <p className="text-sm text-ink-subtle">
            拉流数量与音频转换使用共享配额，
            <Link className="text-primary" to="/config-center?category=streaming">
              前往流媒体配置
            </Link>
            。修改上限不会重启当前运行的媒体连接。
          </p>
          <p className="text-xs text-ink-subtle">
            停用后仅停止 ONVIF 通道拉流，已有通道、录像及 AI
            关联保留。设备证书信任在对应设备中设置。
          </p>
          <button type="button" className="btn-primary min-h-11" onClick={() => void save()}>
            {busy ? '保存中…' : '保存 ONVIF 配置'}
          </button>
        </fieldset>
      )}
    </section>
    <PtzGlobalSettings/>
    </>
  )
}

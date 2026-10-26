import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  onvifService,
  type OnvifBinding,
  type OnvifDevice,
  type OnvifProfile,
} from '@/api/onvifService'

const input = 'mt-1 min-h-11 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm'
interface Props {
  initial?: OnvifBinding
  onDraft: (value: OnvifBinding | null) => void
  onBusy: (busy: boolean) => void
  onDirty: (dirty: boolean) => void
}
export function OnvifSourceFields({ initial, onDraft, onBusy, onDirty }: Props) {
  const [devices, setDevices] = useState<OnvifDevice[]>([]),
    [selected, setSelected] = useState(initial?.deviceId ?? '')
  const [profiles, setProfiles] = useState<OnvifProfile[]>([]),
    [source, setSource] = useState(initial?.videoSource ?? ''),
    [profile, setProfile] = useState(initial ? initial.service + ':' + initial.profileToken : '')
  const [version, setVersion] = useState(initial?.deviceVersion ?? 0),
    [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [name, setName] = useState(''),
    [url, setURL] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [pin, setPin] = useState(''),
    [epr, setEPR] = useState('')
  const [interfaces, setInterfaces] = useState<string[]>([]),
    [iface, setIface] = useState(''),
    [candidates, setCandidates] = useState<{ url: string; epr: string }[]>([])
  const [globallyEnabled, setGloballyEnabled] = useState<boolean | null>(null)
  const [deviceQuery, setDeviceQuery] = useState('')
  const [sourceQuery, setSourceQuery] = useState('')
  const device = devices.find((d) => d.id === selected)
  useEffect(() => {
    let active = true
    void Promise.all([
      onvifService.devices(),
      onvifService.settings(),
      initial ? onvifService.device(initial.deviceId).catch(e=>{if(active)setError(e.message);return null}) : Promise.resolve(null),
    ])
      .then(([d, s, detail]) => {
        if (!active) return
        setGloballyEnabled(s.settings.enabled)
        setDevices(d.items)
        setInterfaces(s.settings.interfaces)
        setIface(s.settings.interfaces[0] ?? '')
        const current = detail
        if (current) {
          setProfiles(current.capabilities?.profiles ?? [])
          setVersion(current.version)
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [initial?.deviceId])
  useEffect(() => {
    const p = profiles.find(
      (p) => p.videoSource === source && p.service + ':' + p.token === profile,
    )
    onDraft(
      p && selected && version
        ? {
            deviceId: selected,
            deviceVersion: version,
            videoSource: p.videoSource,
            service: p.service,
            profileToken: p.token,
          }
        : null,
    )
  }, [selected, version, source, profile, profiles, onDraft])
  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    onBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  function choose(id: string) {
    void action(async () => {
      setSelected(id)
      setEdit(false)
      setMessage('')
      setSourceQuery('')
      setSource('')
      setProfile('')
      setProfiles([])
      setVersion(0)
      onDirty(true)
      if (id) {
        const detail = await onvifService.device(id)
        setProfiles(detail.capabilities?.profiles ?? [])
        setVersion(detail.version)
      }
    })
  }
  function editDevice() {
    if (device) {
      setName(device.name)
      setURL(device.url)
      setUsername(device.username)
      setPin(device.certificateSHA256)
      setPassword('')
      setEPR(device.epr ?? '')
    } else {
      setName('')
      setURL('')
      setUsername('')
      setPassword('')
      setPin('')
      setEPR('')
    }
    setEdit(true)
  }
  async function probe(id: string) {
    const result = await onvifService.probe(id)
    setProfiles(result.capabilities.profiles)
    setVersion(result.version)
    setMessage(
      `已读取 ${result.capabilities.manufacturer} ${result.capabilities.model} · ${result.capabilities.profiles.length} 个码流`,
    )
    setDevices((await onvifService.devices()).items)
  }
  const sources = [...new Set(profiles.map((p) => p.videoSource))]
  return (
    <fieldset disabled={busy} className="space-y-4">
      <div className="rounded-base border border-primary/20 bg-primary/5 p-3 text-sm text-ink">
        选择设备、画面和码流。保存后持续接入音视频，关闭监看页面不会停止录像或识别。
      </div>
      {globallyEnabled === false && (
        <p className="rounded-base border border-line bg-surface-muted p-3 text-sm text-ink-subtle">
          ONVIF 接入尚未启用。请先在
          <Link className="text-primary underline" to="/config-center?category=onvif">系统配置 → ONVIF 接入</Link>
          配置摄像头网段并启用，再返回读取设备码流。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-ink-subtle">
          {message}
        </p>
      )}
      {devices.length > 8 && (
        <label className="block text-sm">
          查找设备
          <input
            className={input}
            value={deviceQuery}
            onChange={(e) => setDeviceQuery(e.target.value)}
            placeholder="设备名称、型号或地址"
          />
        </label>
      )}
      <label className="block text-sm font-medium">
        摄像头 / NVR
        <select
          aria-label="ONVIF 设备"
          value={selected}
          onChange={(e) => choose(e.target.value)}
          className={input}
        >
          <option value="">添加新设备</option>
          {selected&&!device&&<option value={selected}>原设备不可用，请重新选择</option>}
          {devices
            .filter(
              (d) =>
                d.id === selected ||
                `${d.name} ${d.model ?? ''} ${d.url}`
                  .toLowerCase()
                  .includes(deviceQuery.trim().toLowerCase()),
            )
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.model || d.url}
              </option>
            ))}
        </select>
      </label>
      {!selected && (
        <details className="rounded-base border border-line p-3">
          <summary className="cursor-pointer text-sm">在局域网发现摄像头</summary>
          <div className="mt-3 flex gap-2">
            <select
              aria-label="发现网卡"
              className={input}
              value={iface}
              onChange={(e) => setIface(e.target.value)}
            >
              <option value="">选择网卡</option>
              {interfaces.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary min-h-11 mt-1 shrink-0"
              disabled={!iface}
              onClick={() =>
                void action(async () => setCandidates((await onvifService.discover(iface)).items))
              }
            >
              发现
            </button>
          </div>
          {!interfaces.length && (
            <Link
              className="text-sm text-primary"
              to="/config-center?category=onvif"
              target="_blank"
            >
              在系统配置中设置发现网卡
            </Link>
          )}
          <div className="mt-2 max-h-40 overflow-auto">
            {candidates.map((d) => (
              <button
                type="button"
                key={d.epr}
                className="block min-h-11 w-full break-all rounded border border-line p-2 text-left text-sm hover:border-primary"
                onClick={() => {
                  setURL(d.url)
                  setEPR(d.epr)
                  setEdit(true)
                  onDirty(true)
                }}
              >
                {d.url}
                <span className="block text-xs text-ink-subtle">选择此设备</span>
              </button>
            ))}
          </div>
        </details>
      )}
      {(!selected || edit) && (
        <div
          className="space-y-3 rounded-base border border-line bg-surface-page p-3"
          onChange={() => onDirty(true)}
        >
          <label className="block text-sm">
            设备名称
            <input
              aria-label="ONVIF 设备名称"
              className={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            设备服务地址
            <input
              aria-label="ONVIF 服务地址"
              className={input}
              placeholder="http://192.168.1.50/onvif/device_service"
              value={url}
              onChange={(e) => setURL(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              ONVIF 用户名
              <input
                className={input}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="text-sm">
              密码{selected ? '（留空保留）' : ''}
              <input
                type="password"
                className={input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-ink-subtle">HTTPS 设备证书信任</summary>
            <label className="mt-2 block text-sm">
              设备叶证书 SHA-256 指纹
              <input
                className={input}
                value={pin}
                onChange={(e) => setPin(e.target.value.replaceAll(':', '').trim())}
                placeholder="受信任签发证书可留空"
              />
            </label>
            <p className="mt-1 text-xs text-ink-subtle">
              自签证书须先核对设备证书指纹；仅信任此设备，不关闭全局证书验证。
            </p>
          </details>
          {selected && (
            <p className="text-xs text-amber-700">修改设备地址或凭据会影响所有选用此设备的通道。</p>
          )}
          <button
            type="button"
            className="btn-primary min-h-11"
            disabled={!name.trim() || !url.trim()}
            onClick={() =>
              void action(async () => {
                const result = await onvifService.saveDevice({
                  ...(selected ? { id: selected, expectedVersion: device?.version } : {}),
                  name: name.trim(),
                  url: url.trim(),
                  username,
                  certificateSHA256: pin,
                  ...(password || !selected ? { password } : {}),
                  ...(epr ? { epr } : {}),
                })
                setSelected(result.id)
                setVersion(result.version)
                setPassword('')
                setEdit(false)
                setMessage('设备已保存；取消通道向导仍会保留此设备配置。')
                await probe(result.id)
              })
            }
          >
            保存设备并读取码流
          </button>
        </div>
      )}
      {selected && !edit && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary min-h-11"
            onClick={() => void action(() => probe(selected))}
          >
            重新读取码流
          </button>
          <button type="button" className="btn-secondary min-h-11" onClick={editDevice}>
            修改设备连接
          </button>
        </div>
      )}
      {profiles.length > 0 && (
        <>
          {sources.length > 8 && (
            <label className="block text-sm">
              查找画面
              <input
                className={input}
                value={sourceQuery}
                onChange={(e) => setSourceQuery(e.target.value)}
                placeholder="视频源标识或码流名称"
              />
            </label>
          )}
          <label className="block text-sm font-medium">
            画面 / 视频源
            <select
              aria-label="ONVIF 视频源"
              className={input}
              value={source}
              onChange={(e) => {
                setSource(e.target.value)
                setProfile('')
                onDirty(true)
              }}
            >
              <option value="">请选择画面</option>
              {sources
                .filter(
                  (s) =>
                    s === source ||
                    profiles.some(
                      (p) =>
                        p.videoSource === s &&
                        `${s} ${p.name}`.toLowerCase().includes(sourceQuery.trim().toLowerCase()),
                    ),
                )
                .map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            接入码流
            <select
              aria-label="ONVIF 码流"
              className={input}
              value={profile}
              disabled={!source}
              onChange={(e) => {
                setProfile(e.target.value)
                onDirty(true)
              }}
            >
              <option value="">请选择码流</option>
              {profiles
                .filter((p) => p.videoSource === source)
                .map((p) => (
                  <option
                    key={p.service + ':' + p.token}
                    value={p.service + ':' + p.token}
                    disabled={!['H264', 'H265', 'HEVC'].includes(p.videoCodec)}
                  >
                    {p.name || p.token} · {p.videoCodec} · {p.width}×{p.height} ·{' '}
                    {p.fps > 0 ? `最高 ${p.fps} FPS` : '帧率未提供'} · {p.audioCodec || '无音频'} ·{' '}
                    {p.service === 'media1' ? 'Media1' : 'Media2'}
                  </option>
                ))}
            </select>
          </label>
          <p className="text-xs text-ink-subtle">
            优先选择 H.264 以兼容更多终端；H.265
            是否可播放取决于终端解码能力。这里仅选择现有码流，不修改摄像头编码参数。
          </p>
        </>
      )}
      {initial &&
        profiles.length > 0 &&
        !profiles.some(
          (p) =>
            p.service === initial.service &&
            p.token === initial.profileToken &&
            p.videoSource === initial.videoSource,
        ) && (
          <p role="alert" className="text-sm text-amber-700">
            原码流未出现在当前列表，请重新核对并选择；不会自动换成其他画面。
          </p>
        )}
    </fieldset>
  )
}

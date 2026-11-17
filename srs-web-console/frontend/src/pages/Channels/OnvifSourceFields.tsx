import { useEffect, useRef, useState } from 'react'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { Link } from 'react-router-dom'
import {
  onvifService,
  type OnvifBinding,
  type OnvifDevice,
  type OnvifProfile,
} from '@/api/onvifService'

const input = 'mt-1 min-h-11 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm'
const INGESTIBLE = ['H264', 'H265', 'HEVC']
/** The stream to take without asking: the largest one the platform can actually ingest. */
const mainProfile = (list: OnvifProfile[]) =>
  list
    .filter((p) => INGESTIBLE.includes(p.videoCodec))
    .sort((x, y) => y.width * y.height - x.width * x.height)[0]
/** A bare IP or host is the common thing to type; every camera answers at the standard path. */
function deviceServiceUrl(text: string) {
  const raw = text.trim()
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/onvif/device_service'
    return u.toString()
  } catch {
    return raw
  }
}
interface Props {
  initial?: OnvifBinding
  /** The channel name entered in step 1; the device is named after it so nothing is typed twice. */
  defaultName?: string
  onDraft: (value: OnvifBinding | null) => void
  onBusy: (busy: boolean) => void
  onDirty: (dirty: boolean) => void
  /** Hands the wizard the "connect and read" step to run when the person clicks next. */
  onPrepare?: (connect: () => Promise<OnvifBinding | null>) => void
  /** Hands the wizard the way to take back a device this wizard registered, for when it is abandoned. */
  onCleanup?: (discard: () => Promise<void>) => void
}
export function OnvifSourceFields({ initial, defaultName = '', onDraft, onBusy, onDirty, onPrepare, onCleanup }: Props) {
  const createdRef = useRef('')
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
    return result
  }
  /** What "next" does on this page: connect, read the streams and settle every choice that has
   *  only one sensible answer. Returns the binding when nothing is left to choose, else null. */
  async function connect(): Promise<OnvifBinding | null> {
    if (busy) return null
    setError('')
    const editing = !device || edit
    if (editing && !url.trim()) {
      setError('请填写设备服务地址')
      return null
    }
    setBusy(true)
    onBusy(true)
    try {
      let id = device?.id ?? ''
      if (editing) {
        const fullUrl = deviceServiceUrl(url)
        // An address that is already registered is that device: reuse it instead of failing as a duplicate.
        const target = device ?? devices.find((d) => d.url === fullUrl)
        let host = url.trim()
        try {
          host = new URL(fullUrl).hostname
        } catch {
          /* keep the raw text as the name */
        }
        if (!device && target && !username.trim() && !password) {
          // Already registered and nothing new typed: use it as it is. Writing would blank its
          // account for every channel that shares it.
          id = target.id
          setSelected(id)
          setVersion(target.version)
          setEdit(false)
        } else {
          const saved = await onvifService.saveDevice({
            ...(target ? { id: target.id, expectedVersion: target.version } : {}),
            name: name.trim() || target?.name || defaultName || host,
            url: fullUrl,
            username: username.trim() || target?.username || '',
            certificateSHA256: pin || target?.certificateSHA256 || '',
            ...(password || !target ? { password } : {}),
            ...(epr ? { epr } : {}),
          })
          id = saved.id
          if (!target) createdRef.current = saved.id
          setSelected(id)
          setVersion(saved.version)
          setPassword('')
          setEdit(false)
          // The new device must be in the list before anything can fail below.
          setDevices((await onvifService.devices()).items)
        }
      }
      const result = await probe(id)
      const list = result.capabilities.profiles
      const pictures = [...new Set(list.map((p) => p.videoSource))]
      const pictureNow = pictures.includes(source) ? source : pictures.length === 1 ? pictures[0]! : ''
      if (!pictureNow) {
        setMessage('已读取到多个画面，请选择要接入的画面。')
        return null
      }
      const mine = list.filter((p) => p.videoSource === pictureNow)
      const chosen = mine.find((p) => p.service + ':' + p.token === profile) ?? mainProfile(mine)
      if (!chosen) return null
      setSource(pictureNow)
      setProfile(chosen.service + ':' + chosen.token)
      return {
        deviceId: id,
        deviceVersion: result.version,
        videoSource: chosen.videoSource,
        service: chosen.service,
        profileToken: chosen.token,
      }
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  useEffect(() => {
    onPrepare?.(connect)
    onCleanup?.(async () => {
      const id = createdRef.current
      if (!id) return
      createdRef.current = ''
      try {
        await onvifService.removeDevice(id, (await onvifService.device(id)).version)
      } catch {
        /* Used by a channel or already gone: nothing to undo. */
      }
    })
  })
  const sources = [...new Set(profiles.map((p) => p.videoSource))]
  // Defaults that need no decision. A picture is never guessed when the device has several
  // (an NVR); a stream within the chosen picture defaults to the largest, the main stream.
  useEffect(() => {
    if (!source && sources.length === 1) setSource(sources[0]!)
  }, [sources.join('|'), source]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!source || profile) return
    const main = mainProfile(profiles.filter((p) => p.videoSource === source))
    if (main) setProfile(main.service + ':' + main.token)
  }, [source, profile, profiles])
  return (
    <fieldset disabled={busy} className="space-y-4">
      <div className="rounded-base border border-primary/20 bg-primary/5 p-3 text-sm text-ink">
        填写摄像头的地址和账号，点“下一步”自动连接并读取画面和码流。保存后持续接入音视频，关闭监看页面不会停止录像或识别。
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
      {/* This wizard configures one camera. Other cameras are edited from the channel list. */}
      {device && (
        <p className="text-sm">
          当前摄像头：<strong>{device.name}</strong>
          {device.capabilities?.model ? ` · ${device.capabilities.model}` : ''}
        </p>
      )}
      {selected && !device && (
        <p role="alert" className="text-sm text-amber-700">
          原摄像头已不存在，请重新填写它的地址和账号。
        </p>
      )}
      {!device && (
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
      {(!device || edit) && (
        <div
          className="space-y-3 rounded-base border border-line bg-surface-page p-3"
          onChange={() => onDirty(true)}
        >
          {selected && (
            <label className="block text-sm">
              设备名称
              <input
                aria-label="ONVIF 设备名称"
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
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
              <PasswordInput
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
        </div>
      )}
      {device && !edit && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary min-h-11"
            onClick={() => void action(async () => void (await probe(selected)))}
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
                    disabled={!INGESTIBLE.includes(p.videoCodec)}
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

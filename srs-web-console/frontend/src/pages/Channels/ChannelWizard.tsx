import { useEffect, useState } from 'react'
import type {GBBinding} from './gbTypes'
import {GBSourceFields,type GBSourceDraft} from './GBSourceFields'
import {OnvifSourceFields} from './OnvifSourceFields'
import {onvifService,type OnvifBinding} from '@/api/onvifService'
import {request} from '@/api/httpClient'
import { ingestService, type IngestCapabilities } from '@/api/ingestService'
import { Check, RefreshCw, X } from 'lucide-react'
import {
  DEFAULT_WIZARD_VALUE,
  fromChannel,
  generateStreamName,
  toServiceInput,
  validateStep1,
  validateStep2,
  validateStep3,
  type FieldErrors,
  type WizardFormValue,
} from '@/features/channelForm'
import type { ChannelCreateInput } from '@/api/channelService'
import {
  DOWNSTREAM_LABEL,
  UPSTREAM_LABEL,
  type ChannelWithStatus,
  type DownstreamProtocol,
} from '@/types/channel'

const STEPS = ['基本信息', '接入参数', '播放设置'] as const

const inputCls =
  'w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-primary'

interface Props {
  gbBinding?: GBBinding
  onGBSaved?: () => void
  onOnvifSaved?: () => void
  open: boolean
  mode: 'create' | 'edit'
  initial?: ChannelWithStatus | null
  submitting?: boolean
  onClose: () => void
  onSubmit: (input: ChannelCreateInput) => Promise<void> | void
}

const PROTOCOL_HINT: Record<DownstreamProtocol, string> = {
  flv: '低延迟，网页直播常用',
  hls: '兼容性最好，延迟 6-12s',
  webrtc: '超低延迟，需浏览器支持',
  rtmp: '仅生成地址，网页不能直播',
  srt: '仅生成地址，网页不能直播',
}

/** 创建/编辑通道 3 步向导（DEV_PLAN 用例 1 / 4.2） */
export function ChannelWizard({
  open,
  mode,
  initial,
  submitting = false,
  onClose,
  onSubmit,
  gbBinding,
  onGBSaved,
  onOnvifSaved,
}: Props) {
  const [onvifMode,setOnvifMode]=useState(false)
  const [onvifDraft,setOnvifDraft]=useState<OnvifBinding|null>(null)
  const [onvifDirty,setOnvifDirty]=useState(false)
  const [onvifBusy,setOnvifBusy]=useState(false)
  const [saving,setSaving]=useState(false)
  const [gbDraft,setGbDraft]=useState<GBSourceDraft|null>(null)
  const [gbMode,setGbMode]=useState(false)
  const [gbBusy,setGbBusy]=useState(false)
  const [gbDirty,setGbDirty]=useState(false)
  const [step, setStep] = useState(0)
  const [value, setValue] = useState<WizardFormValue>(DEFAULT_WIZARD_VALUE)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [step3Error, setStep3Error] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<IngestCapabilities | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setCapabilities(null)
    ingestService.capabilities(controller.signal).then(setCapabilities).catch(() => {})
    return () => controller.abort()
  }, [open])

  useEffect(() => {
    if (open) {
      setSaving(false)
      setGbDraft(null)
      setGbBusy(false)
      setGbMode(!!gbBinding)
      setOnvifMode(!!initial?.onvif)
      setOnvifDraft(initial?.onvif??null)
      setOnvifDirty(false)
      setOnvifBusy(false)
      setGbDirty(false)
      setStep(0)
      setErrors({})
      setStep3Error(null)
      setValue(mode === 'edit' && initial ? {...fromChannel(initial),...(gbBinding?.channel_config?{name:gbBinding.channel_config.name,description:gbBinding.channel_config.description,protocols:gbBinding.channel_config.protocols,primary:gbBinding.channel_config.primary}:{})} : { ...DEFAULT_WIZARD_VALUE })
    }
  }, [open, mode, initial, gbBinding])

  const baseline=mode==='edit'&&initial?{...fromChannel(initial),...(gbBinding?.channel_config?{name:gbBinding.channel_config.name,description:gbBinding.channel_config.description,protocols:gbBinding.channel_config.protocols,primary:gbBinding.channel_config.primary}:{})}:DEFAULT_WIZARD_VALUE
  const dirty=onvifMode!==!!initial?.onvif||onvifDirty||gbMode!==!!gbBinding||gbDirty||JSON.stringify(value)!==JSON.stringify(baseline)
  function close(){if(submitting||gbBusy||onvifBusy||saving)return;if(dirty&&!window.confirm('放弃尚未保存的通道修改？已保存的设备信息会保留。'))return;onClose()}
  useEffect(()=>{if(!open)return;const previous=document.activeElement as HTMLElement|null;return()=>previous?.focus()},[open])
  if (!open) return null

  const set = <K extends keyof WizardFormValue>(key: K, v: WizardFormValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }))

  function handleNext() {
    if (step === 0) {
      const e = validateStep1(gbMode||onvifMode?{...value,sourceType:'push'}:value)
      setErrors(e)
      if (Object.keys(e).length > 0) return
    }
    if (step === 1 && gbMode) {
      const error=validateGB();setStep3Error(error);if(error)return
    }
    if (step === 1 && onvifMode && !onvifDraft) {setStep3Error('请读取设备并选择画面和码流');return}
    if (step === 1 && !gbMode && !onvifMode) {
      const e = validateStep2(value)
      setErrors(e)
      if (Object.keys(e).length > 0) return
    }
    setErrors({})
    setStep((s) => s + 1)
  }

  function validateGB(){
    if(!gbDraft?.ready)return '国标配置尚未读取成功，请重新读取后重试'
    if(gbDraft.registrationDirty)return '请先保存或取消设备注册信息的修改'
    if(!gbDraft.deviceId||(gbDraft.batch?!gbDraft.channels.length:!gbDraft.channelId))return '请选择国标设备和视频目录通道'
    return null
  }
  async function handleSubmit() {
    if(saving||gbBusy||onvifBusy)return
    if(onvifMode){
      const error=(!onvifDraft?'请读取设备并选择画面和码流':null)||validateStep3(value)||validateStep1({...value,sourceType:'push'}).name
      setStep3Error(error??null);if(error||!onvifDraft)return
      setSaving(true);try{await onvifService.saveChannel({binding:onvifDraft,...(mode==='edit'&&initial?{inputId:initial.id,expectedGeneration:initial.inputGeneration}:{}),config:{name:value.name.trim(),remark:value.description.trim(),downstreamProtocols:value.protocols,primaryProtocol:value.primary,inputEnabled:value.inputEnabled??true}});onOnvifSaved?.()}catch(e){setStep3Error((e as Error).message)}finally{setSaving(false)}
      return
    }
    if(gbMode){
      const error=validateGB()||validateStep3(value)||validateStep1({...value,sourceType:'push'}).name
      setStep3Error(error??null);if(error||!gbDraft)return
      setSaving(true)
      try{
        const config={name:value.name.trim(),description:value.description.trim(),protocols:value.protocols,primary:value.primary}
        if(gbDraft.batch){
          const channels=gbDraft.channels.map(c=>({deviceId:gbDraft.deviceId,channelId:c.id,transport:gbDraft.transport,enabled:gbDraft.enabled,config:{...config,name:config.name+' · '+c.name}}))
          if(channels.some(c=>c.config.name.length>50)){setStep3Error('批量通道名称超过 50 字，请缩短基本信息中的名称');return}
          await request('/gb28181/channel-configs',{method:'POST',body:JSON.stringify({expectedRevision:gbDraft.revision,channels})})
        }else await request('/gb28181/channel-config',{method:'POST',body:JSON.stringify({expectedRevision:gbDraft.revision,deviceId:gbDraft.deviceId,channelId:gbDraft.channelId,...(gbBinding?{inputId:gbBinding.input_id}:{}),transport:gbDraft.transport,enabled:gbDraft.enabled,config})})
        onGBSaved?.()
      }catch(e){setStep3Error((e as Error).message)}finally{setSaving(false)}
      return
    }
    const protocol = value.sourceType === 'rtsp' ? 'rtsp' : value.upstreamProtocol
    // 编辑时没改接入协议（如只改名称）不受接入能力查询结果影响
    const unchanged = mode === 'edit' && initial?.upstream.protocol === protocol
    if (protocol !== 'rtmp' && !unchanged && !capabilities?.[protocol]?.enabled) {
      setStep3Error(capabilities?.[protocol]?.reason || '接入能力尚未就绪，请稍后重试')
      return
    }
    const err = validateStep3(value)
    setStep3Error(err)
    if (err) return
    await onSubmit(toServiceInput(value))
  }

  function toggleProtocol(p: DownstreamProtocol) {
    setValue((prev) => {
      const has = prev.protocols.includes(p)
      const protocols = has
        ? prev.protocols.filter((x) => x !== p)
        : [...prev.protocols, p]
      const primary = protocols.includes(prev.primary)
        ? prev.primary
        : (protocols[0] ?? prev.primary)
      return { ...prev, protocols, primary }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-6"
      onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}if(e.key==='Tab'){const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')).filter(el=>el.getClientRects().length>0);const first=controls[0],last=controls[controls.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}}}
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'create' ? '新建通道' : '编辑通道'}
    >
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[640px] flex-col overflow-hidden rounded-panel bg-surface shadow-modal sm:max-h-[calc(100dvh-3rem)]">
        {/* 头部：标题 + 步骤指示 */}
        <div className="shrink-0 border-b border-line px-4 pb-4 pt-5 sm:px-6">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-ink">
              {mode === 'create' ? '新建通道' : `编辑通道${initial ? ` · ${initial.name}` : ''}`}
            </h3>
            <button
              type="button"
              disabled={submitting||gbBusy||onvifBusy||saving}
              onClick={close}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-faint hover:bg-surface-page hover:text-ink"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
          <ol className="mt-4 flex items-center justify-between gap-1 sm:gap-2">
            {STEPS.map((label, i) => (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={[
                    'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                    i < step
                      ? 'bg-success text-white'
                      : i === step
                        ? 'bg-primary text-white'
                        : 'bg-surface-page text-ink-faint',
                  ].join(' ')}
                >
                  {i < step ? <Check size={13} /> : i + 1}
                </span>
                <span
                  className={[
                    'text-xs',
                    i === step ? 'font-medium text-ink' : 'text-ink-faint',
                  ].join(' ')}
                >
                  {label}
                </span>
                {i < STEPS.length - 1 && (
                  <span aria-hidden className="mx-1 hidden h-px w-8 bg-line sm:block" />
                )}
              </li>
            ))}
          </ol>
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {step === 0 && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium text-ink">
                  通道名称 <span className="text-danger">*</span>
                </label>
                <input
                  autoFocus
                  value={value.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="如：大门摄像头"
                  className={`mt-1.5 ${inputCls}`}
                  data-testid="wizard-name"
                />
                {errors.name && <p className="mt-1 text-xs text-danger">{errors.name}</p>}
              </div>
              <div>
                <label className="text-sm font-medium text-ink">备注</label>
                <textarea
                  value={value.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="选填，如位置、用途"
                  rows={2}
                  className={`mt-1.5 resize-none ${inputCls}`}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-ink">接入协议</label>
                <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {(
                    [
                      ['push', '直推（RTMP/SRT/WebRTC）'],
                      ['rtsp', 'RTSP 摄像头拉流'],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      aria-pressed={!gbMode&&!onvifMode&&value.sourceType===v}
                      type="button"
                      disabled={!!gbBinding || !!initial?.onvif || (v === 'rtsp' && !capabilities?.rtsp.enabled)}
                      onClick={() => {if((gbDirty||onvifDirty)&&!window.confirm('放弃设备接入参数草稿并更换协议？'))return;setOnvifMode(false);setOnvifDirty(false);setOnvifDraft(null);setGbMode(false);setGbDirty(false);setGbDraft(null);set('sourceType', v)}}
                      className={[
                        'flex-1 rounded-base border px-3 py-2.5 text-sm transition-colors',
                        !gbMode && !onvifMode && value.sourceType === v
                          ? 'border-primary bg-primary-100 font-medium text-primary-600'
                          : 'border-line text-ink-subtle hover:border-primary-200',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  ))}
                  <button type="button" disabled={mode==='edit'&&!initial?.onvif} onClick={()=>{if(gbDirty&&!window.confirm('放弃国标参数草稿？'))return;setOnvifMode(true);setGbMode(false);setGbDirty(false)}} aria-pressed={onvifMode} className={`min-h-11 rounded-base border px-3 py-2.5 text-sm disabled:opacity-40 ${onvifMode?'border-primary bg-primary-100 font-medium text-primary-600':'border-line text-ink-subtle hover:border-primary-200'}`}>ONVIF 摄像头 / NVR</button>
                  <button type="button" disabled={mode==='edit'&&!gbBinding} onClick={()=>{if(onvifDirty&&!window.confirm('放弃 ONVIF 参数草稿？'))return;setOnvifMode(false);setOnvifDirty(false);setGbMode(true)}} aria-pressed={gbMode} className={`min-h-11 rounded-base border px-3 py-2.5 text-sm disabled:opacity-40 ${gbMode?'border-primary bg-primary-100 font-medium text-primary-600':'border-line text-ink-subtle hover:border-primary-200'}`}>GB/T 28181 摄像头 / NVR</button>
                </div>
                {mode==='edit'&&!gbBinding&&<p className="mt-1 text-xs text-ink-faint">国标设备请通过新建通道接入，现有视频源的录像和 AI 关联会保留。</p>}
                {gbBinding&&<p className="mt-1 text-sm text-primary">来源：GB/T 28181；内部发布地址由网关管理。</p>}
              </div>
              {value.sourceType === 'rtsp' && !gbMode && !onvifMode && (
                <div>
                  <label className="text-sm font-medium text-ink">
                    RTSP 源地址 <span className="text-danger">*</span>
                  </label>
                  <input
                    value={value.rtspUrl}
                    onChange={(e) => set('rtspUrl', e.target.value)}
                    placeholder="rtsp://192.168.1.50:554/stream1"
                    className={`mt-1.5 font-mono ${inputCls}`}
                    data-testid="wizard-rtsp"
                  />
                  {errors.rtspUrl && (
                    <p className="mt-1 text-xs text-danger">{errors.rtspUrl}</p>
                  )}
                  <p className="mt-1 text-xs text-ink-faint">
                    视频直接接入，不重新编码；首期不接入音频。保存后异步连接，只影响本通道。
                  </p>
                  <label className="mt-3 block text-sm">相机用户名</label>
                  <input className={inputCls} autoComplete="off" value={value.inputUsername ?? ''} onChange={e => set('inputUsername', e.target.value)} />
                  <label className="mt-3 block text-sm">相机密码（编辑时留空保留原值）</label>
                  <input type="password" className={inputCls} autoComplete="new-password" value={value.inputPassword ?? ''} onChange={e => set('inputPassword', e.target.value)} />
                  <label className="mt-3 block text-sm">相机传输方式</label>
                  <select className={inputCls} value={value.rtspTransport ?? 'tcp'} onChange={e => set('rtspTransport', e.target.value as 'tcp' | 'udp')}>
                    <option value="tcp">TCP（推荐）</option><option value="udp">UDP</option>
                  </select>
                  <label className="mt-3 block text-sm">音频<select className={inputCls} value={value.inputAudioMode ?? 'off'} onChange={e => set('inputAudioMode', e.target.value as 'off' | 'auto')}><option value="off">仅视频</option><option value="auto">自动接入音频</option></select></label>
                  <p className="mt-1 text-xs text-ink-subtle">AAC 保持原音频；G.711／G.726 在配额内转换。不支持音频时继续接入视频并提示原因。</p>
                  <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={value.inputEnabled ?? true} onChange={e => set('inputEnabled', e.target.checked)} />启用输入（关闭后录像和识别等待源）</label>
                </div>
              )}
              {value.sourceType === 'push' && !gbMode && !onvifMode && !gbBinding && (
                <div>
                  <label className="text-sm font-medium text-ink">上行协议</label>
                  <select
                    value={value.upstreamProtocol}
                    onChange={(e) => set('upstreamProtocol', e.target.value as WizardFormValue['upstreamProtocol'])}
                    className={`mt-1.5 ${inputCls}`}
                  >
                    {(['rtmp', 'srt', 'webrtc'] as const).map((p) => (
                      <option key={p} value={p} disabled={p !== 'rtmp' && !capabilities?.[p].enabled}>
                        {UPSTREAM_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {!gbMode && !onvifMode && capabilities && <p className="text-xs text-ink-faint">{value.sourceType === 'rtsp' ? capabilities.rtsp.reason : capabilities[value.upstreamProtocol].reason}
                {value.upstreamProtocol === 'webrtc' && value.sourceType === 'push' ? '使用 WHIP 发送端；创建后在通道详情生成专用发布凭据。浏览器编码能力因设备而异。' : ''}</p>}
              <div className="rounded-base border border-line bg-surface-page px-3 py-3 text-xs leading-6 text-ink-subtle">
                <p className="font-medium text-ink">编码自动识别</p>
                <p>视频编码自动识别，支持 H.264 / H.265；RTMP 支持 H.265 codec12。</p>
                <p className="text-ink-faint">编码在摄像头或推流设备上设置，接入后可在通道详情查看，无需在此选择。</p>
              </div>
            </div>
          )}

          {gbMode&&<div hidden={step!==1}><GBSourceFields binding={gbBinding} onDraft={setGbDraft} onDirty={setGbDirty} onBusy={setGbBusy}/>{step===1&&step3Error&&<p role="alert" className="mt-2 text-sm text-danger">{step3Error}</p>}</div>}
          {onvifMode&&<div hidden={step!==1}><OnvifSourceFields initial={initial?.onvif} onDraft={setOnvifDraft} onDirty={setOnvifDirty} onBusy={setOnvifBusy}/><label className="mt-4 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={value.inputEnabled??true} onChange={e=>set('inputEnabled',e.target.checked)}/>启用此输入通道</label>{step===1&&step3Error&&<p role="alert" className="mt-2 text-sm text-danger">{step3Error}</p>}</div>}
          {step === 1 && !gbMode && !onvifMode && (
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-sm font-medium text-ink">应用名</label>
                <input
                  readOnly={!!gbBinding}
                  value={value.app}
                  onChange={(e) => set('app', e.target.value)}
                  className={`mt-1.5 font-mono ${inputCls}`}
                  data-testid="wizard-app"
                />
                {errors.app && <p className="mt-1 text-xs text-danger">{errors.app}</p>}
              </div>
              <div>
                <label className="text-sm font-medium text-ink">
                  流名 <span className="text-danger">*</span>
                </label>
                <div className="mt-1.5 flex gap-2">
                  <input
                    readOnly={!!gbBinding}
                    value={value.stream}
                    onChange={(e) => set('stream', e.target.value)}
                    placeholder="如 cam_main_door"
                    className={`flex-1 font-mono ${inputCls}`}
                    data-testid="wizard-stream"
                  />
                  <button
                    type="button"
                    disabled={!!gbBinding}
                    onClick={() => set('stream', generateStreamName(value.name || 'cam'))}
                    className="shrink-0 rounded-base border border-line px-3 text-sm text-ink-subtle hover:border-primary hover:text-primary"
                    title="随机生成"
                  >
                    <RefreshCw size={14} className="inline" aria-hidden /> 生成
                  </button>
                </div>
                {errors.stream && <p className="mt-1 text-xs text-danger">{errors.stream}</p>}
                <p className="mt-1 text-xs text-ink-faint">
                  {gbBinding?'国标网关自动发布，设备无需填写此 RTMP 地址。':`摄像头/OBS 将推流到 rtmp://主机:1935/${value.app}/${value.stream || '流名'}`}
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              {gbMode&&<p className="mb-4 rounded-base bg-primary-50 p-3 text-sm">将保存「{value.name}」及所选国标视频通道、传输方式和播放设置；服务会在后台应用，设备离线不影响保存。</p>}
              {gbMode&&gbDraft?.batch&&<ul className="mb-4 max-h-32 overflow-auto text-sm">{gbDraft.channels.map(c=><li key={c.id}>{value.name} · {c.name}</li>)}</ul>}
              <label className="text-sm font-medium text-ink">
                启用哪些下行协议（可多选）
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(Object.keys(DOWNSTREAM_LABEL) as DownstreamProtocol[]).map((p) => {
                  const active = value.protocols.includes(p)
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => toggleProtocol(p)}
                      className={[
                        'rounded-base border px-3 py-2.5 text-left transition-colors',
                        active
                          ? 'border-primary bg-primary-100'
                          : 'border-line hover:border-primary-200',
                      ].join(' ')}
                      data-testid={`proto-${p}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold text-ink">
                          {DOWNSTREAM_LABEL[p]}
                        </span>
                        <span
                          aria-hidden
                          className={[
                            'flex h-4 w-4 items-center justify-center rounded-full text-[10px] text-white',
                            active ? 'bg-primary' : 'bg-ink-faint/40',
                          ].join(' ')}
                        >
                          {active ? '✓' : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-faint">{PROTOCOL_HINT[p]}</div>
                    </button>
                  )
                })}
              </div>
              {step3Error && <p className="mt-2 text-xs text-danger">{step3Error}</p>}

              <div className="mt-2 rounded-base border border-info-200 bg-info-50 p-3 text-xs text-info-700">
                💡 这些开关只决定生成哪些播放地址，不是访问控制开关：流媒体服务当前对所有协议全局放行，即使这里未启用某协议，知道地址规则的人仍可能访问到对应的流。
                <br />
                H.265 摄像头：网页实时播放需要浏览器有 H.265 硬件解码（iPad/Safari，或开启硬解的 Chrome/Edge）；
                浏览器不支持 WebRTC H.265 时会自动改用 HLS（需在此启用 HLS），延迟较高且无识别框。
              </div>

              <div className="mt-4">
                <label className="text-sm font-medium text-ink">网页备用播放偏好</label>
                <select
                  value={value.primary}
                  onChange={(e) => set('primary', e.target.value as DownstreamProtocol)}
                  className={`mt-1.5 ${inputCls}`}
                  data-testid="wizard-primary"
                >
                  {value.protocols.map((p) => (
                    <option key={p} value={p}>
                      {DOWNSTREAM_LABEL[p]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ink-faint">
                  启用 WebRTC 时网页优先使用它以同步识别框；H.265 能力不足时使用已启用的 HLS。未启用 WebRTC 时才按此偏好播放。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-4 sm:px-6">
          <button
            type="button"
            disabled={submitting||gbBusy||onvifBusy||saving}
            onClick={step === 0 ? close : () => setStep((s) => s - 1)}
            className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
          >
            {step === 0 ? '取消' : '← 上一步'}
          </button>
          {step < 2 ? (
            <button
              type="button"
              disabled={gbBusy||saving}
              onClick={handleNext}
              className="rounded-base bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-600"
              data-testid="wizard-next"
            >
              下一步 →
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting||saving||gbBusy}
              onClick={handleSubmit}
              className="rounded-base bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
              data-testid="wizard-submit"
            >
              {submitting||saving ? '保存中…' : mode === 'create' ? '创建通道' : '保存修改'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

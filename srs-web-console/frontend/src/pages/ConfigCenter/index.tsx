import { configApplySummary, usesStartupConfig } from '@/features/configApplySummary'
import {AlarmServiceConfigForm} from './AlarmServiceConfigForm'
import {LlmServiceConfigForm} from './LlmServiceConfigForm'
import {GBConfigForm} from './GBConfigForm'
import {OnvifConfigForm} from './OnvifConfigForm'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, CircleAlert, Clock3, Loader2 } from 'lucide-react'
import { configService, type ApplyOperation, type ConfigDocument, type ConfigChange, type ServiceState } from '@/api/configService'
import { useConfigApply } from '@/hooks/useConfigApply'
import { ConfigApplyOverlay } from '@/components/common/ConfigApplyOverlay'
import { Toaster } from '@/components/ui/Toaster'
import { systemService } from '@/api/systemService'
import { useSettingsStore } from '@/store/settings'
import { BasicConfigForm } from './BasicConfigForm'
import { DatabaseConfigForm } from './DatabaseConfigForm'
import { StreamingConfigForm } from './StreamingConfigForm'
import { AiServiceConfigForm } from './AiServiceConfigForm'
import { RecorderConfigForm } from './RecorderConfigForm'
import { SearchServiceConfigForm } from './SearchServiceConfigForm'
import { NetworkConfigForm } from './NetworkConfigForm'
import { SystemTimeForm } from './SystemTimeForm'
import { RemoteAssistForm } from './RemoteAssistForm'
import LicensePage from '@/pages/License'

// SERVICES ≠ categories 上面那份 UI 分类列表：这份是纯后端服务查找表，
// backend 的 servicesContract.test.ts 用正则读这个文件比对 CONFIG_SERVICES，
// 网络管理走 os-helper、不是 PG 配置服务，不在这张表里。
export const SERVICES: { key: string; label: string; description: string }[] = [
  { key: 'backend', label: 'Web 控制台', description: '系统设置、AI 服务、监控阈值等' },
  { key: 'srs', label: '流媒体服务', description: '流媒体服务连接与实时播放配置' },
  { key: 'ai-service', label: 'AI 微服务', description: 'AI 模型、识别参数等' },
  { key: 'recorder', label: '录像服务', description: '录像存储、保留策略等' },
  { key: 'alarm-service', label: '告警微服务', description: '行为分析、告警与统计' },
  { key: 'llm-service', label: '大模型微服务', description: '图片复审、调用与资源' },
  { key: 'search-service', label: '智能搜索服务', description: '搜索模型、采集范围与索引' },
]
const categories: [string, string, string][] = [
  ['basic', '基础配置', '监看上限、访问密码'],
  ['database', '数据库配置', '参数库、AI识别历史库'],
  ['streaming', '流媒体配置', '流媒体服务连接、WebRTC 候选地址'],
  ['gb28181', '国标接入配置', 'SIP 平台、媒体端口、接入容量'],
  ['onvif', 'ONVIF 接入', '设备发现、访问网段、服务连接'],
  ['ai-service', 'AI微服务配置', '识别服务连接、鉴权'],
  ['recorder', '录像微服务配置', '存储、配额、分段'],
  ['alarm-service', '告警微服务配置', '独立服务连接、数据库、鉴权'],
  ['llm-service', '大模型微服务配置', '模型、复审参数、资源与调用'],
  ['search-service', '智能搜索', '模型、采集范围、历史与索引存储'],
  ['network', '网络管理', '网卡状态、IP 配置、WiFi'],
  ['time', '日期和时间', '设备时间、校准、时间服务器'],
  ['license', '授权管理', '机器码、注册密钥、授权状态'],
  ['remote-assist', '远程协助', '中转服务器、开关与记录'],
]

const stateView: Record<ServiceState['status'], { label: string; tone: string }> = {
  applied: { label: '已应用', tone: 'bg-success-50 text-success-700' },
  pending: { label: '等待应用', tone: 'bg-amber-50 text-amber-800' },
  partial: { label: '等待重启', tone: 'bg-amber-50 text-amber-800' },
  restarting: { label: '正在重启', tone: 'bg-primary-50 text-primary-600' },
  failed: { label: '应用失败', tone: 'bg-danger-50 text-danger-700' },
  unknown: { label: '状态未知', tone: 'bg-surface-page text-ink-subtle' },
}

function ConfigStatus({ states, operation, error }: { states: ServiceState[]; operation: ApplyOperation | null; error: string }) {
  const latest = states.map(s => s.appliedAt ? Date.parse(s.appliedAt) : 0).filter(Boolean).sort((a, b) => b - a)[0]
  const summary = configApplySummary(states, operation, SERVICES.map(s => s.key), error)
  const operationText = summary.text
  return <section className="ui-panel p-4 sm:p-5" aria-labelledby="config-status-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="config-status-title" className="text-sm font-semibold text-ink">配置应用状态</h2>
        <p className="mt-1 text-xs text-ink-subtle">保存只应用本次涉及的服务；页面会等待服务确认后再报告成功。</p></div>
      <div className="text-right text-xs text-ink-subtle">
        <div className="flex items-center justify-end gap-1.5 font-medium text-ink">
          {summary.tone === 'running' ? <Loader2 size={14} className="animate-spin text-primary" /> : summary.tone !== 'success' ? <CircleAlert size={14} className="text-danger" /> : <CheckCircle2 size={14} className="text-success" />}
          {operationText}
        </div>
        <div className="mt-1">{latest ? `最近确认 ${new Date(latest).toLocaleString('zh-CN', { hour12: false })}` : '暂无应用时间'} · <Link className="text-primary-600 hover:underline" to="/dashboard?tab=logs">查看运行日志</Link></div>
      </div>
    </div>
    {error ? <p role="alert" className="mt-3 text-xs text-danger-700">应用状态暂时不可用：{error}</p> :
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {SERVICES.map(service => {
          const state = states.find(s => s.serviceName === service.key)
          const startup = usesStartupConfig(state)
          const view = startup ? {label: '使用现有配置', tone: 'bg-surface-page text-ink-subtle'} : stateView[state?.status ?? 'unknown']
          const version = state?.desiredVersion ?? state?.appliedVersion
          return <div key={service.key} className="rounded-base border border-line bg-surface-page/60 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-ink">{service.label}</span><span className={`rounded-full px-2 py-0.5 text-[11px] ${view.tone}`}>{view.label}</span></div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-subtle"><Clock3 size={12} aria-hidden />{version ? `配置版本 v${version}` : startup ? '尚未发布配置；保存后自动应用' : '尚未上报版本'}</div>
            {state?.errorMessage && <p className="mt-1 line-clamp-2 text-[11px] text-danger-700" title={state.errorMessage}>{state.errorMessage}</p>}
          </div>
        })}
      </div>}
  </section>
}

export default function ConfigCenterPage() {
  const [params, setParams] = useSearchParams()
  const category = categories.some(c => c[0] === params.get('category')) ? params.get('category')! : 'basic'
  const [documents, setDocuments] = useState<ConfigDocument[]>([])
  const [runtimeSettings, setRuntimeSettings] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const applying = useConfigApply()
  const [passwordBusy, setPasswordBusy] = useState(false)
  const form = useRef<HTMLDivElement>(null)
  const [loadError, setLoadError] = useState('')
  const [serviceStates, setServiceStates] = useState<ServiceState[]>([])
  const [lastOperation, setLastOperation] = useState<ApplyOperation | null>(null)
  const [statusError, setStatusError] = useState('')
  const busy = applying.busy || passwordBusy
  const load = useCallback(async (savedServices: string[]) => {
    const fresh = await configService.listDocuments()
    // Other documents can still have unsaved drafts (for example Candidate IP).
    // Do not advance their expected version without reloading those drafts.
    setDocuments(previous => [
      ...previous.filter(d => !savedServices.includes(d.service)),
      ...fresh.filter(d => savedServices.includes(d.service)),
    ])
  }, [])
  const loadStatus = useCallback(async () => {
    try {
      const [states, operation] = await Promise.all([configService.listServiceStates(), configService.getApplyOperation()])
      setServiceStates(states); setLastOperation(operation); setStatusError('')
    } catch (e) { setStatusError(e instanceof Error ? e.message : '读取失败') }
  }, [])
  useEffect(() => {
    let cancelled = false
    void configService.listDocuments().then(async docs => {
      const backend = docs.find(d => d.service === 'backend' && d.group === 'system' && d.name === 'settings')
      const runtime = backend ? null : await systemService.getSettings()
      if (!cancelled) { setDocuments(docs); setRuntimeSettings(runtime ? { ...runtime } : null) }
    })
      .catch(() => { if (!cancelled) setLoadError('加载失败，请重新进入本页重试') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    void loadStatus()
    const timer = window.setInterval(() => { if (!document.hidden) void loadStatus() }, applying.busy ? 2000 : 10000)
    return () => window.clearInterval(timer)
  }, [loadStatus, applying.busy])
  const saveBatch = useCallback(async (changes: ConfigChange[]) => {
    await applying.apply(changes.map(change => ({ ...change,
      expectedUpdatedAt: documents.find(d => d.service === change.service && d.group === change.group && d.name === change.name)?.updatedAt ?? null,
    })))
    await useSettingsStore.getState().invalidate().catch(() => undefined)
    await Promise.all([load(changes.map(c => c.service)), loadStatus()])
  }, [applying.apply, documents, load, loadStatus])
  const savePartial = (service: string, group: string, name: string, config: Record<string, unknown>, description?: string) =>
    saveBatch([{ service, group, name, config, description }])
  // 授权管理、远程协助不走配置发布，不显示配置应用状态
  const standalone = category === 'onvif' || category === 'gb28181' || category === 'license' || category === 'remote-assist' || category === 'time' || category === 'network'
  const doc = (service: string) => documents.find(d => d.service === service && d.group === 'system' && d.name === 'settings')
    ?? (service === 'backend' && runtimeSettings ? { service, group: 'system', name: 'settings', config: runtimeSettings } as ConfigDocument : undefined)
  return <div className="flex flex-col gap-4">
    <Toaster />
    <div><h1 className="page-title">系统配置</h1>
      <p className="page-description">集中管理各服务参数，各项配置会说明生效方式；保存后请确认应用结果，部分操作会短暂中断对应服务</p></div>
    {!standalone && <ConfigStatus states={serviceStates} operation={lastOperation} error={statusError} />}
    {!standalone && (applying.outcome || loadError) && <div role="status" className="rounded-base border border-line bg-surface p-3 text-sm">{applying.outcome || loadError}</div>}
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[220px_1fr]">
      <nav aria-label="配置分类" className="ui-panel grid grid-cols-2 gap-1 p-1.5 sm:grid-cols-3 xl:sticky xl:top-0 xl:grid-cols-1">
        {categories.map(([key, label, description]) => <button key={key} disabled={busy} onClick={() => {
          if (key === category) return
          if (form.current?.querySelector('[data-unsaved="true"]') && !window.confirm('当前分类有未保存的修改，确认放弃并切换？')) return
          setParams(previous => { const next = new URLSearchParams(previous); next.set('category', key); return next })
        }}
          aria-current={category === key ? 'page' : undefined}
          className={`block w-full rounded-base px-3 py-2.5 text-left ${category === key ? 'bg-primary-100 text-primary-600' : 'text-ink hover:bg-surface-hover'}`}>
          <div className="text-sm font-medium">{label}</div><div className="text-xs text-ink-faint">{description}</div>
        </button>)}
      </nav>
      <div ref={form} className="min-w-0">
      {category === 'license' ? <div className="min-w-0"><LicensePage embedded /></div>
        // 远程协助不依赖参数库：参数库故障时恰恰需要它，不能被文档加载挡住。
        : category === 'remote-assist' ? <div className="min-w-0"><RemoteAssistForm /></div>
        // 日期和时间同样不依赖参数库：时间无效、业务暂停时必须能进来校准
        : category === 'time' ? <div className="min-w-0"><SystemTimeForm /></div>
        : category === 'onvif' ? <OnvifConfigForm /> : category === 'gb28181' ? <GBConfigForm /> : category === 'network' ? <NetworkConfigForm /> : loading ? <p>加载中…</p> : loadError ? null : <fieldset disabled={busy} className="min-w-0">
        {category === 'basic' && <BasicConfigForm backendDoc={doc('backend')} onSavePartial={savePartial}
          onBusyChange={setPasswordBusy} />}
        {category === 'alarm-service' && <AlarmServiceConfigForm document={doc('alarm-service')} onSaveBatch={saveBatch} />}
        {category === 'llm-service' && <LlmServiceConfigForm key={doc('llm-service')?.updatedAt??'new'} document={doc('llm-service')} onSaveBatch={saveBatch} />}
        {category === 'search-service' && <SearchServiceConfigForm key={doc('search-service')?.updatedAt ?? 'new'} document={doc('search-service')} onSaveBatch={saveBatch} />}
        {category === 'database' && <DatabaseConfigForm aiServiceDoc={doc('ai-service')} onSavePartial={savePartial} />}
        {category === 'streaming' && <StreamingConfigForm backendDoc={doc('backend')} srsDoc={doc('srs')} onSavePartial={savePartial} />}
        {category === 'ai-service' && <AiServiceConfigForm backendDoc={doc('backend')} aiServiceDoc={doc('ai-service')} onSaveBatch={saveBatch} />}
        {category === 'recorder' && <RecorderConfigForm recorderDoc={doc('recorder')} onSavePartial={savePartial} />}
      </fieldset>}
      </div>
    </div>
    <ConfigApplyOverlay busy={busy} stage={passwordBusy ? '正在更新访问密码' : applying.stage} remaining={passwordBusy ? 30 : applying.remaining} />
  </div>
}

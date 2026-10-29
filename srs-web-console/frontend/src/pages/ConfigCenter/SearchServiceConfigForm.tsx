import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { searchService, type SearchModelCatalog, type SearchStatus, type SearchChannel } from '@/api/searchService'
import type { ConfigChange, ConfigDocument } from '@/api/configService'
import { StorageDirectoryPicker } from '@/components/StorageDirectoryPicker'
import { Section, Field, inputCls } from './fields'
import {SearchModelMigrationPanel} from './SearchModelMigrationPanel'
import { SearchCapacityStatus } from './SearchCapacityStatus'

const defaults = {
  schema_version: '1.0', enabled: false, listen: { host: '127.0.0.1', port: 8400 }, callers: [],
  history: { source: 'ai-history' }, index_storage: { volume_id: null as string | null, relative_path: 'ainvr/search-index' },
  model: { package_id: 'siglip2-base-full-int8' as string | null }, sampling: { mode: 'all', channel_ids: [] as string[], object: true, scene: true,
    object_interval_ms: 1000, scene_active_interval_ms: 10000, scene_static_interval_ms: 60000,
    scene_change_min_interval_ms: 3000, track_slots: 8 },
  limits: { query_concurrency: 2, http_workers: 4, http_queue: 4, producer_queue: 1, producer_bytes: 134217728,
    max_samples: 100000, max_bytes: 1073741824, retention_days: 30, max_coverage: 100000,
    max_searches: 1000, search_ttl_s: 3600, image_max_bytes: 8388608 },
}
export const searchReadiness = (status: SearchStatus | null) => status?.ready ? '模型与索引已就绪' : ({
  disabled: '智能搜索未启用', config_pending: '配置等待应用', model_pending: '模型或索引尚未就绪',
  service_unavailable: '搜索服务暂不可用', storage_unavailable: '历史或索引存储不可用',
}[status?.reason ?? 'service_unavailable'])

export function SearchServiceConfigForm({ document, onSaveBatch,onReload }: {
  document?: ConfigDocument; onSaveBatch: (changes: ConfigChange[]) => Promise<unknown>;onReload?:()=>Promise<unknown>
}) {
  const config = document?.config ?? {}
  const sampling = { ...defaults.sampling, ...(config.sampling as Partial<typeof defaults.sampling> | undefined) }
  const limits = { ...defaults.limits, ...(config.limits as Partial<typeof defaults.limits> | undefined) }
  const [enabled, setEnabled] = useState(config.enabled === true)
  const savedModel = (config.model as { package_id?: string | null } | undefined)?.package_id
  const [model, setModel] = useState(savedModel === undefined ? defaults.model.package_id ?? '' : savedModel ?? '')
  const [storage, setStorage] = useState({ ...defaults.index_storage, ...(config.index_storage as Partial<typeof defaults.index_storage> | undefined) })
  const [mode, setMode] = useState(sampling.mode)
  const [selected, setSelected] = useState<string[]>(sampling.channel_ids)
  const [days, setDays] = useState(String(limits.retention_days))
  const [quota, setQuota] = useState(String(limits.max_bytes / 1073741824))
  const [filter, setFilter] = useState('')
  const [catalog, setCatalog] = useState<SearchModelCatalog | null>(null)
  const [channels, setChannels] = useState<SearchChannel[]>([])
  const [status, setStatus] = useState<SearchStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [migrationRequired,setMigrationRequired]=useState(false),[migrationActive,setMigrationActive]=useState(false)
  const signature = JSON.stringify({ enabled, model, storage, mode, selected: mode === 'all' ? [] : selected, days, quota })
  const [savedSignature, setSavedSignature] = useState(signature)
  const dirty = signature !== savedSignature
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true); setLoadError('')
    Promise.allSettled([searchService.models(abort.signal), searchService.channels(abort.signal), searchService.status(abort.signal)])
      .then(([models, sources, state]) => {
        if (abort.signal.aborted) return
        setCatalog(models.status === 'fulfilled' ? models.value : null)
        if (sources.status === 'fulfilled') setChannels(sources.value.items)
        setStatus(state.status === 'fulfilled' ? state.value : null)
        if ([models, sources, state].some(result => result.status === 'rejected')) setLoadError('部分运行信息暂不可用，已保存的配置与本次输入仍保留。')
      }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [retry])
  const change = () => { setMessage('') }
  const visible = channels.filter(channel => channel.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const unsupported = channels.filter(channel => channel.sampling_supported === false)
  const missing = selected.filter(id => !channels.some(channel => channel.id === id))
  const selectedModel = catalog?.items.find(item => item.package_id === model)
  async function save() {
    if(migrationRequired||migrationActive){setMessage('请先完成或取消模型迁移；迁移不会自动保存本页其它参数。');return}
    const retention = Number(days), bytes = Math.round(Number(quota) * 1073741824)
    if (!Number.isInteger(retention) || retention < 1 || retention > 365 || !Number.isFinite(bytes) || bytes < 134217728 || bytes > 1099511627776) {
      setMessage('保留时间需为 1–365 天，容量需为 0.125–1024 GB。'); return
    }
    if (mode === 'selected' && (!selected.length || selected.length > 100)) { setMessage('请指定 1–100 个 AI 输出通道。'); return }
    if (enabled && (!model || !storage.volume_id)) { setMessage('启用前请选择模型包和外挂存储；当前可先保存关闭状态。'); return }
    setBusy(true); setMessage('')
    try {
      await onSaveBatch([{ service: 'search-service', group: 'system', name: 'settings', config: {
        ...defaults, ...config, enabled, callers: [], history: defaults.history, listen: defaults.listen,
        model: { package_id: model || null }, index_storage: storage,
        sampling: { ...sampling, mode, channel_ids: mode === 'all' ? [] : selected },
        limits: { ...limits, retention_days: retention, max_bytes: bytes },
      } }])
      setSavedSignature(signature); setMessage('配置已提交并确认应用；能否搜索以上方实际运行状态为准。')
      setRetry(value => value + 1)
    } catch (error) { setMessage(`${error instanceof Error ? error.message : '保存失败'}；输入已保留，请确认应用状态后重试。`) }
    finally { setBusy(false) }
  }
  return <fieldset disabled={busy} className="min-w-0 space-y-4" data-unsaved={dirty}>
    <Section title="智能搜索" hint="采集可搜索的目标与场景，沿用现有历史库。配置应用成功与模型就绪分别确认。">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-base border border-line bg-surface-page p-3">
        <div><p role="status" className="text-sm font-medium text-ink">{loading ? '正在检查搜索状态…' : !document && status?.reason === 'config_pending' ? '尚未配置，默认关闭' : searchReadiness(status)}</p>
          <p className="mt-1 text-xs text-ink-subtle">关闭功能不删除既有索引。服务未就绪时不会把搜索失败显示成没有结果。</p></div>
        <button type="button" className="btn-secondary min-h-11" disabled={loading} onClick={() => setRetry(value => value + 1)}>重新检查</button>
      </div>
      {loadError && <p role="alert" className="text-sm text-amber-800">{loadError}</p>}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium"><input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); change() }} />启用智能搜索</label>
      <Field label="搜索模型包" hint="只展示已发现的配套模型。模型、分词器与索引版本必须匹配，不接受手填模型路径。">
        <select aria-label="搜索模型包" className={`${inputCls} min-h-11`} value={model} onChange={event => { setModel(event.target.value); change() }}>
          <option value="">{loading ? '正在读取模型包…' : '请选择模型包'}</option>
          {model && !selectedModel && <option value={model}>{loading || !catalog ? `模型包（列表尚未确认）：${model}` : savedModel === undefined && model === defaults.model.package_id ? 'SigLIP2 Base 256 · 完整词表 INT8（当前未发现）' : `已保存模型包（当前未发现）：${model}`}</option>}
          {catalog?.items.map(item => <option key={item.package_id} value={item.package_id}>{item.display_name} · 文件已发现</option>)}
        </select>
      </Field>
      {!loading && !catalog?.items.length && <p className="text-sm text-amber-800">{catalog?.service_ready ? '尚未发现模型包文件，可先保存关闭状态。' : '模型包列表暂不可用，已保存的选择会保留；服务运行状态以上方为准。'}</p>}
      {selectedModel && <p className="text-xs text-ink-subtle">已发现所选模型包文件，运行是否就绪以上方实际状态为准。已有搜索空间时，更换模型需要先迁移留存证据。</p>}
      {dirty && <p className="text-xs text-ink-subtle">本次修改尚未应用；上方状态仍对应当前运行配置。</p>}
      <p className="text-xs text-ink-subtle">保存会等待服务应用；更换存储可能需要重新加载。模型迁移只重编码已有留存截图，不能补造没有采集过的历史。</p>
    </Section>
    {document&&<SearchModelMigrationPanel target={model} targetVersion={selectedModel?.model_version??null} onRequired={setMigrationRequired} onActive={setMigrationActive} onReload={onReload} />}
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <Section title="采集范围" hint="使用 AI 输出通道，保留原始摄像头与录像身份。符合画面处理条件时，支持跟踪的通道采集目标，其余通道仍可采集场景。全景采集待验证。">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([['all', '全部符合条件的通道'], ['selected', '仅指定通道']] as const).map(([value, label]) => <label key={value} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-base border p-3 text-sm ${mode === value ? 'border-primary bg-primary-50 text-primary-600' : 'border-line'}`}>
            <input type="radio" name="search-sampling-mode" value={value} checked={mode === value} onChange={() => { setMode(value); change() }} />{label}</label>)}
        </div>
        {mode === 'all' ? <div className="space-y-1"><p className="text-xs text-ink-subtle">新建且符合条件的 AI 输出也会自动纳入，采用系统默认的目标与场景采样策略。</p>
          {unsupported.length > 0 && <p className="text-xs text-amber-800">{unsupported.length} 个通道全景采集待验证，暂不新增采集；已有历史仍可查询。</p>}</div> : <>
          <div className="flex flex-wrap items-center gap-2"><input aria-label="查找采集通道" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索通道名称…" className={`${inputCls} min-h-11 min-w-0 flex-1`} /><span className="text-xs text-ink-subtle">已选 {selected.length} / 100</span></div>
          <div className="grid max-h-64 grid-cols-1 gap-1 overflow-auto rounded-base border border-line p-2 sm:grid-cols-2">
            {visible.map(channel => <label key={channel.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-base px-2 hover:bg-primary-50"><input type="checkbox" checked={selected.includes(channel.id)} disabled={!selected.includes(channel.id) && (selected.length >= 100 || channel.sampling_supported === false)} onChange={event => { setSelected(ids => event.target.checked ? [...ids, channel.id] : ids.filter(id => id !== channel.id)); change() }} /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{channel.name}</span>{channel.sampling_supported === false && <span className="block text-xs text-amber-800">全景采集待验证</span>}</span></label>)}
            {!loading && !visible.length && <p className="p-2 text-sm text-ink-subtle">暂无匹配的 AI 输出通道</p>}
          </div>
          {missing.length > 0 && <div className="rounded-base bg-amber-50 p-3 text-sm text-amber-800">{missing.length} 个已选通道当前不可用，选择仍保留。<button type="button" className="ml-2 min-h-11 underline" onClick={() => { setSelected(ids => ids.filter(id => !missing.includes(id))); change() }}>移除不可用选择</button></div>}
        </>}
      </Section>
      <SearchCapacityStatus key={`capacity-${retry}`} />
    <Section title="索引与历史存储" hint="参数保存在现有参数库；图片、向量与元数据复用 AI 识别历史库。下方选择的是外挂存储上的派生索引目录，不会改变历史库的数据位置或连接。">
        <StorageDirectoryPicker value="" currentSelection={storage.volume_id ? { volumeId: storage.volume_id, relativePath: storage.relative_path } : undefined} label="选择索引磁盘" hint="索引仅使用已挂载的外挂存储。选择后保存才生效；不会格式化、迁移或清空已有数据。" defaultRelativePath="ainvr/search-index" onSelection={selection => { setStorage({ volume_id: selection.volumeId, relative_path: selection.relativePath }); change() }} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="保留时间（天）"><input aria-label="搜索保留时间（天）" type="number" min="1" max="365" value={days} onChange={event => { setDays(event.target.value); change() }} className={`${inputCls} min-h-11`} /></Field>
          <Field label="搜索证据容量上限（GB）" hint="历史库中的搜索图片、向量与元数据共用此额度，不含数据库索引、日志和原始录像。容量满时自动淘汰最旧证据，按保留期清理；已有录像不会删除。"><input aria-label="搜索证据容量上限（GB）" type="number" min="0.125" max="1024" step="0.125" value={quota} onChange={event => { setQuota(event.target.value); change() }} className={`${inputCls} min-h-11`} /></Field>
        </div>
      </Section>
      {message && <p role="status" className="rounded-base border border-line bg-surface p-3 text-sm">{message}</p>}
      {migrationActive&&<p className="text-xs text-amber-800">迁移进行中。参数草稿保留，完成或取消迁移后才能保存其它修改，避免改变正在验收的范围。</p>}
      <div className="flex flex-wrap items-center gap-3"><button type="button" className="btn-primary min-h-11" onClick={() => void save()} disabled={(!dirty && !!document && savedModel !== undefined) || busy||migrationRequired||migrationActive}>{busy ? '正在应用…' : '保存并应用'}</button><Link className="inline-flex min-h-11 items-center text-sm text-primary-600" to="/smart-search">前往智能搜索</Link></div>
    </fieldset>
  </fieldset>
}

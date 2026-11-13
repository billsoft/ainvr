import { useEffect, useRef, useState } from 'react'
import { faceError, faceService, readFaceJpeg, type FaceChannel, type FaceModel, type FacePage, type FaceScope } from '@/api/faceService'
import { aiChannelService } from '@/api/aiChannelService'
import { channelService } from '@/api/channelService'
import { isAiChannelOf, streamKey } from '@/utils/channelMatching'
import { newOperationId } from '@/utils/operationId'
import { FaceLiveResults, FaceRuntimeState } from './FaceConnectedShared'

const localTime = (milliseconds: number) => { const date = new Date(milliseconds); return new Date(milliseconds - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
/** The page may name either an input channel or the analysis channel that reads it. */
async function pageChannel(channelId: string | undefined, items: FaceChannel[]): Promise<string | null> {
  if (!channelId) return null
  if (items.some(item => item.id === channelId)) return channelId
  try {
    const [analysis, inputs] = await Promise.all([aiChannelService.get(channelId), channelService.list()])
    if (!analysis) return null
    const output = analysis.config.publish?.enabled ? streamKey(analysis.config.publish.effective_target_url || analysis.config.publish.target_url) : null
    const allowed = inputs.filter(input => items.some(item => item.id === input.id))
    return (output ? allowed.find(input => `${input.upstream.app}/${input.upstream.stream}` === output)?.id : null)
      ?? allowed.find(input => isAiChannelOf(analysis, input))?.id ?? null
  } catch { return null }
}
export function FaceQueryConnected({ mode, channelId }: { mode: 'history' | 'search'; channelId?: string }) {
  const [channels, setChannels] = useState<FaceChannel[]>([]), [selected, setSelected] = useState<string[]>([])
  const [model, setModel] = useState<FaceModel | null>(null), [models, setModels] = useState<FaceModel[]>([]), [currentModel, setCurrentModel] = useState<FaceModel | null>(null), [modelError, setModelError] = useState(''), [modelReload, setModelReload] = useState(0)
  const [scopeReady, setScopeReady] = useState<string | null>(null), [scoped, setScoped] = useState(false), [from, setFrom] = useState(() => localTime(Date.now() - 86400000)), [to, setTo] = useState(() => localTime(Date.now()))
  const [file, setFile] = useState<File | null>(null), [result, setResult] = useState<FacePage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('')
  const request = useRef<AbortController | null>(null), generation = useRef(0), searchId = useRef<string | null>(null), fileInput = useRef<HTMLInputElement>(null)
  const queryAttempt = useRef<{ payload: string; id: string } | null>(null)
  useEffect(() => {
    let live = true
    clearResult(); setScopeReady(null); setChannels([]); setSelected([]); setScoped(false)
    void faceService.channels().then(async value => {
      const chosen = await pageChannel(channelId, value.items)
      if (!live) return
      clearResult(); setChannels(value.items); setScoped(!!chosen)
      setSelected(chosen ? [chosen] : channelId ? [] : value.items.map(item => item.id).slice(0, 100))
      setScopeReady(channelId ?? '')
    }).catch(reason => { if (live) setError(faceError(reason)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])
  // Queries use the feature model the device runs; captures kept from an earlier setting stay selectable.
  useEffect(() => {
    let live = true
    setModel(null); setModelError('')
    void faceService.status().then(status => {
      if (!live) return
      const current = status.active_model ?? status.desired_model ?? null, kept = status.spaces.map(space => space.model)
      const all = [...new Set([...(current ? [current] : []), ...(mode === 'history' ? kept : [])])]
      setCurrentModel(current); setModels(all); setModel(all[0] ?? null)
      if (!all.length) setModelError(mode === 'history' ? '暂无可查询的抓拍批次；配置人脸库并产生抓拍后，请重新读取设置。' : '尚无当前识别方案；请先配置人脸库并核对运行状态。')
    }).catch(reason => { if (live) setModelError(`无法读取抓拍设置：${faceError(reason)}`) })
    return () => { live = false }
  }, [modelReload, mode])
  useEffect(() => () => { generation.current++; request.current?.abort(); if (searchId.current) void faceService.cancel(searchId.current).catch(() => undefined) }, [])
  function clearResult() { generation.current++; request.current?.abort(); if (searchId.current) void faceService.cancel(searchId.current).catch(() => undefined); searchId.current = null; queryAttempt.current = null; setBusy(false); setResult(null); setError(''); setNote('') }
  async function query(more = false) {
    if (scopeReady !== (channelId ?? '') || !model) return
    if (!selected.length || !from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)) { setError('请选择通道和有效时间范围。'); return }
    if (mode === 'search' && !file) { setError('请先选择本地JPEG照片。'); return }
    const scope: FaceScope = { channel_ids: selected, from: new Date(from).toISOString(), to: new Date(to).toISOString() }
    const controller = new AbortController(), ticket = ++generation.current
    request.current?.abort(); request.current = controller; setBusy(true); setError(''); setNote('')
    try {
      let page: FacePage
      if (mode === 'search') {
        const jpeg_base64 = await readFaceJpeg(file!)
        if (generation.current !== ticket) return
        const payload = JSON.stringify([scope, model, jpeg_base64])
        if (queryAttempt.current?.payload !== payload) queryAttempt.current = { payload, id: newOperationId('uuid') }
        searchId.current = queryAttempt.current.id
        page = await faceService.search({ request_id: searchId.current, scope, model, limit: 20, jpeg_base64 }, controller.signal)
      } else page = await faceService.history({ scope, model, limit: 20, ...(more && result?.next_cursor ? { cursor: result.next_cursor } : {}) }, controller.signal)
      if (generation.current !== ticket) return
      setResult(previous => more && previous ? { ...page, items: [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.id === item.id))] } : page)
      setNote(mode === 'search' ? '已按相似度排序，分数不是身份概率。' : '已读取所选识别方案的保留抓拍，包含模型更新前的历史批次；覆盖未知时不推断唯一人数。')
    } catch (reason) { if (generation.current === ticket) setError(faceError(reason)) }
    finally { if (generation.current === ticket) { setBusy(false); request.current = null } }
  }
  async function cancel() {
    const id = searchId.current; clearResult(); setNote('已停止等待查询。')
    if (id) try { await faceService.cancel(id); setNote('搜索已取消，照片选择和查询条件已保留。') } catch (reason) { setError(`取消尚未确认：${faceError(reason)}；服务端请求仍受超时与保留期限限制。`) }
  }
  return <section aria-label={mode === 'search' ? '设备以脸查找' : '设备人脸抓拍'} className="space-y-4">
    <div className="ui-panel space-y-4 p-4"><h2 className="text-base font-semibold">{mode === 'search' ? '以脸查找' : '人脸抓拍历史'}</h2><FaceRuntimeState />
      {channelId && <p className="text-xs text-ink-subtle">{scopeReady !== channelId ? '正在核对当前通道…' : scoped ? '已按当前通道筛选，可在下方增减查询通道。' : '当前通道未匹配到可查询来源。请选择查询通道，不会自动扩大范围。'}</p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"><label className="min-w-0 text-sm">开始时间<input type="datetime-local" className="form-input min-h-11 mt-1 w-full min-w-0 max-w-full" value={from} onChange={event => { clearResult(); setFrom(event.target.value) }} /></label><label className="min-w-0 text-sm">结束时间<input type="datetime-local" className="form-input min-h-11 mt-1 w-full min-w-0 max-w-full" value={to} onChange={event => { clearResult(); setTo(event.target.value) }} /></label>{models.length > 1 && <label className="text-sm">识别方案<select className="form-input min-h-11 mt-1" value={model ?? ''} disabled={!model} onChange={event => { clearResult(); setModel(event.target.value as FaceModel) }}>{models.map((value, index) => <option key={value} value={value}>{value === currentModel ? (mode === 'history' ? '当前方案（含保留的历史批次）' : '当前识别方案') : `保留的识别方案 ${index + 1}`}</option>)}</select></label>}</div>
      <fieldset className="rounded-base border border-line p-3"><legend className="px-1 text-sm">查询通道</legend><div className="grid gap-1 sm:grid-cols-2">{channels.map(channel => <label key={channel.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(channel.id)} onChange={event => { clearResult(); setSelected(old => event.target.checked ? [...old, channel.id] : old.filter(value => value !== channel.id)) }} />{channel.name}</label>)}</div>{!channels.length && <p className="text-sm text-ink-subtle">尚无可查询通道或通道列表不可用。</p>}</fieldset>
      {mode === 'search' && <div className="space-y-2"><label className="block text-sm">选择查询照片（JPEG，最多4MB）<input ref={fileInput} type="file" accept="image/jpeg" className="mt-1 block min-h-11 w-full text-sm" onChange={event => { clearResult(); setFile(event.target.files?.[0] ?? null) }} /></label><p className="text-xs text-ink-subtle">点击“上传照片并搜索”才发送照片到设备。查询照片仅用于本次提取，不作为入库成员或抓拍保存；范围过大时请缩短时间或减少通道。</p><p className="break-all text-sm">{file ? `已选择 ${file.name}；尚未证明人脸质量合格` : '尚未选择照片'}</p></div>}
      <div className="flex flex-wrap gap-2"><button className="btn-primary min-h-11" disabled={busy || scopeReady !== (channelId ?? '') || !model || !selected.length || (mode === 'search' && !file)} onClick={() => void query()}>{busy ? '正在查询…' : mode === 'search' ? '上传照片并搜索' : '查询抓拍历史'}</button>{busy && <button className="btn-secondary min-h-11" onClick={() => void cancel()}>取消查询</button>}{mode === 'search' && <button className="btn-secondary min-h-11" disabled={!file && !result} onClick={() => { clearResult(); setFile(null); if (fileInput.current) fileInput.current.value = '' }}>清除照片与结果</button>}</div>
      {modelError && <div role="alert" className="space-y-2 text-sm text-danger"><p>{modelError}</p><button className="btn-secondary min-h-11" onClick={() => { clearResult(); setModelReload(value => value + 1) }}>重新读取设置</button></div>}
      {error && <p role="alert" className="text-sm text-danger">{error} 输入已保留。</p>}{note && <p role="status" className="text-sm text-ink-subtle">{note}</p>}
    </div>
    {result && <FaceLiveResults records={result.items} coverage={result.coverage} channelNames={Object.fromEntries(channels.map(channel => [channel.id, channel.name]))} />}
    {mode === 'history' && result?.next_cursor && <button className="btn-secondary min-h-11" disabled={busy} onClick={() => void query(true)}>加载更多抓拍</button>}
  </section>
}

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { faceError, faceService, readFaceJpeg, type FaceChannel, type FaceLibrary, type FaceLibraryDocument, type FaceModel, type FaceStatus, type FaceTemplate } from '@/api/faceService'
import { newOperationId } from '@/utils/operationId'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { FacePreviewModal } from './FacePreviewShared'
import { FaceMemberPhoto } from './FaceMemberPhoto'
import { FaceRuntimeState } from './FaceConnectedShared'

const blank = (): FaceLibraryDocument => ({ name: '', model: 'mbf', channel_ids: [], valid_until: new Date(Date.now() + 30 * 86400000).toISOString(), retention_days: 30, match_requested: false, match_threshold: null, access: 'console-management', members: [] })
const registrationSettings = (document: FaceLibraryDocument) => JSON.stringify([document.model, document.retention_days, document.valid_until, [...document.channel_ids].sort(), document.access])
type ActiveSpace = FaceStatus['spaces'][number] | undefined
const needsRegistration = (template: FaceTemplate, model: FaceModel, active: ActiveSpace) => template.model !== model || !!active && (template.model !== active.model || template.space_id !== active.space_id)
const versionConflict = (error: unknown) => (error as { status?: number; code?: string })?.status === 409 && (error as { code?: string })?.code === 'version_conflict'
function Editor({ initial, id, channels, activeSpace, onClose, onSaved }: { initial: FaceLibrary | null; id: string; channels: FaceChannel[]; activeSpace: ActiveSpace; onClose: () => void; onSaved: (library: FaceLibrary) => void }) {
  const [document, setDocument] = useState<FaceLibraryDocument>(() => initial ? structuredClone(initial.document) : blank())
  const [saved, setSaved] = useState(initial)
  const original = useRef(JSON.stringify(document))
  const [version, setVersion] = useState(initial?.version ?? 0), [templates, setTemplates] = useState<Record<string, FaceTemplate>>(initial?.templates ?? {})
  const [files, setFiles] = useState<Record<string, File>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [discard, setDiscard] = useState(false)
  const [latest, setLatest] = useState<FaceLibrary | null>(null), [conflict, setConflict] = useState(false), [overwrite, setOverwrite] = useState(false)
  const [openPhotos, setOpenPhotos] = useState<Record<string, boolean>>({})
  const saveAttempt = useRef<{ payload: string; key: string } | null>(null)
  const uploadAttempts = useRef(new Map<string, { payload: string; id: string }>())
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const registrationDirty = !saved || registrationSettings(document) !== registrationSettings(saved.document)
  const dirty = JSON.stringify(document) !== original.current || Object.keys(files).length > 0
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose() }
  const patch = (change: Partial<FaceLibraryDocument>) => { setDocument(old => ({ ...old, ...change })); setError('') }
  const member = (id: string, change: Partial<FaceLibraryDocument['members'][number]>) => patch({ members: document.members.map(value => value.id === id ? { ...value, ...change } : value) })
  const clearFile = (memberId: string) => {
    if (fileInputs.current[memberId]) fileInputs.current[memberId]!.value = ''
    setFiles(old => { const next = { ...old }; delete next[memberId]; return next })
    setError('')
  }
  async function save() {
    if (!document.name.trim() || !document.channel_ids.length || document.members.some(value => !value.name.trim())) { setError('请填写库与成员名称，并选择允许使用的通道。'); return }
    if (Object.keys(files).length) { setError('还有已选择但未上传的照片，请先上传或清除选择后再保存。'); return }
    setBusy(true); setError('')
    try {
      const payload = JSON.stringify({ version, document })
      if (saveAttempt.current?.payload !== payload) saveAttempt.current = { payload, key: newOperationId('uuid') }
      onSaved(await faceService.save(id, version, document, saveAttempt.current.key))
    } catch (reason) { setError(faceError(reason)); if (versionConflict(reason)) setConflict(true) }
    finally { setBusy(false) }
  }
  async function upload(memberId: string) {
    const file = files[memberId]; if (!file) return
    if (registrationDirty || conflict) { setError('请先保存登记设置并核对版本，再上传成员照片。'); return }
    setBusy(true); setError('')
    try {
      const jpeg_base64 = await readFaceJpeg(file), payload = JSON.stringify([version, document.model, jpeg_base64])
      if (uploadAttempts.current.get(memberId)?.payload !== payload) uploadAttempts.current.set(memberId, { payload, id: newOperationId('uuid') })
      const template = await faceService.enroll(id, memberId, { request_id: uploadAttempts.current.get(memberId)!.id, expected_version: version, model: document.model, jpeg_base64 })
      setTemplates(old => ({ ...old, [memberId]: template })); member(memberId, { template_id: template.template_id })
      clearFile(memberId)
    } catch (reason) { setError(faceError(reason)); if (versionConflict(reason)) setConflict(true) }
    finally { setBusy(false) }
  }
  async function readLatest() { setBusy(true); try { setLatest(await faceService.library(id)) } catch (reason) { setError(faceError(reason)) } finally { setBusy(false) } }
  return <><FacePreviewModal title={initial ? '编辑设备人脸库' : '新建设备人脸库'} onClose={close} footer={<><button className="btn-secondary min-h-11" disabled={busy} onClick={close}>取消</button><button className="btn-primary min-h-11" disabled={busy || conflict} onClick={() => void save()}>{busy ? '正在处理…' : '保存库配置'}</button></>}>
    <p className="rounded-base bg-surface-page p-3 text-sm">名单只在所选通道使用。成员照片检查合格后才参与比对；比对结果需人工确认。</p>
    {registrationDirty && <p role="status" className="rounded-base border border-amber-200 p-3 text-sm">登记设置尚未保存。请先清除已选照片并保存库配置，再重新打开编辑上传；照片将按已保存的模型、通道、有效期和保留天数登记。</p>}
    <fieldset disabled={busy} data-unsaved={dirty ? 'true' : undefined} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">库名称<input className="form-input min-h-11 mt-1" maxLength={80} value={document.name} onChange={event => patch({ name: event.target.value })} /></label><label className="text-sm">名单有效期<input type="date" className="form-input min-h-11 mt-1" value={document.valid_until.slice(0, 10)} onChange={event => { if (event.target.value) patch({ valid_until: new Date(`${event.target.value}T23:59:59`).toISOString() }) }} /></label><label className="text-sm">比对精度<select className="form-input min-h-11 mt-1" value={document.model} onChange={event => patch({ model: event.target.value as FaceModel })}><option value="mbf">标准（速度快，默认）</option><option value="r50">高精度（速度较慢）</option></select></label><label className="text-sm">后续照片保留天数<input type="number" min={1} max={90} className="form-input min-h-11 mt-1" value={document.retention_days} onChange={event => patch({ retention_days: Number(event.target.value) })} /></label></div>
      <details className="text-xs text-ink-subtle"><summary className="flex min-h-11 cursor-pointer items-center">比对精度与照片保留说明</summary><p className="mt-2">设备同一时间只使用一种比对精度，所有生效中的人脸库须保持一致；更换后需重新上传成员照片。保留天数只对之后上传的照片生效，已有照片的到期时间不变。</p></details>
      <div className="space-y-2 rounded-base border border-line p-3"><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={document.match_requested} onChange={event => patch({ match_requested: event.target.checked })} />抓拍到相似人脸时生成告警</label><label className="block text-sm">相似度阈值（-1 到 1，越高越严格）<input type="number" min={-1} max={1} step={0.01} className="form-input min-h-11 mt-1" value={document.match_threshold ?? ''} onChange={event => patch({ match_threshold: event.target.value === '' ? null : Number(event.target.value) })} /></label><p className="text-xs text-ink-subtle">没有通用的推荐值，建议从 0.5 起按现场抓拍效果调整。超过阈值只生成待人工确认的告警，不代表已确认身份。</p></div>
      <fieldset className="rounded-base border border-line p-3"><legend className="px-1 text-sm">允许使用的通道</legend><div className="grid gap-1 sm:grid-cols-2">{channels.map(channel => <label key={channel.id} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={document.channel_ids.includes(channel.id)} onChange={event => patch({ channel_ids: event.target.checked ? [...document.channel_ids, channel.id] : document.channel_ids.filter(value => value !== channel.id) })} />{channel.name}</label>)}</div>{!channels.length && <p className="text-sm text-amber-800">没有可访问的通道，暂时不能保存。</p>}</fieldset>
      <section aria-label="设备人脸库成员" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">成员 · {document.members.length}</h3><button className="btn-secondary min-h-11" disabled={document.members.length >= 500} onClick={() => memberAdd()}>添加成员</button></div>
        {document.members.map((value, index) => { const template = templates[value.id], stored = saved?.document.members.some(item => item.id === value.id), expired = template && Date.parse(template.expires_at) <= Date.now(); return <article key={value.id} className="space-y-3 rounded-base border border-line p-3" aria-label={`设备成员 ${index + 1}`}>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">成员名称 {index + 1}<input className="form-input min-h-11 mt-1" maxLength={80} value={value.name} onChange={event => member(value.id, { name: event.target.value })} /></label><label className="text-sm">成员备注 {index + 1}<input className="form-input min-h-11 mt-1" maxLength={240} value={value.note} onChange={event => member(value.id, { note: event.target.value })} /></label></div>
          <p className="text-xs text-ink-subtle">{template ? expired ? '照片/特征已过期，请重新上传' : needsRegistration(template, document.model, activeSpace) ? '模型已更新，请重新上传照片以重新登记；原照片按原期限保留' : `几何检查通过 · 保留至 ${new Date(template.expires_at).toLocaleString()}` : '尚未上传照片'}。</p>
          {stored && initial?.templates[value.id] && <details className="text-xs" onToggle={event => { const open = event.currentTarget.open; setOpenPhotos(old => ({ ...old, [value.id]: open })) }}><summary className="flex min-h-11 cursor-pointer items-center">查看已保存的成员照片</summary>{openPhotos[value.id] && <FaceMemberPhoto libraryId={id} memberId={value.id} revision={version} />}</details>}
          <label className="block text-sm">成员照片 {index + 1}<input ref={element => { fileInputs.current[value.id] = element }} type="file" accept="image/jpeg" disabled={!stored} className="mt-1 block min-h-11 w-full text-xs" onChange={event => { const file = event.target.files?.[0]; setFiles(old => { const next = { ...old }; if (file) next[value.id] = file; else delete next[value.id]; return next }) }} /></label>
          <div className="flex flex-wrap gap-2"><button className="btn-secondary min-h-11" disabled={!stored || !files[value.id] || registrationDirty || conflict} onClick={() => void upload(value.id)}>{stored ? '上传照片' : '请先保存成员配置'}</button>{files[value.id] && <button type="button" className="btn-secondary min-h-11" aria-label={`清除已选照片 ${index + 1}`} onClick={() => clearFile(value.id)}>清除已选照片</button>}<button className="btn-secondary min-h-11" onClick={() => { patch({ members: document.members.filter(item => item.id !== value.id) }); clearFile(value.id) }}>移除此成员</button></div>

        </article> })}
      </section>
    </fieldset>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {conflict && <div className="space-y-2 rounded-base border border-amber-200 p-3"><p className="text-sm">保存发生冲突，当前输入保持不变。请读取最新内容并核对后再保存。</p><button className="btn-secondary min-h-11" disabled={busy} onClick={() => void readLatest()}>读取最新版本（保留输入）</button>{latest && <><p className="text-sm">最新 v{latest.version} · {latest.document.name} · {latest.document.members.length} 位成员</p><p className="max-h-24 overflow-y-auto text-xs">{latest.document.members.map(value => value.name).join('、') || '暂无成员'}</p><button className="btn-secondary min-h-11" onClick={() => setOverwrite(true)}>核对后以当前输入重试</button></>}</div>}
    </FacePreviewModal><ConfirmDialog open={discard} title="放弃未保存的人脸库修改？" content="放弃当前输入。已保存的配置不回滚；未引用的已上传照片按原保留期限清理。" confirmText="放弃修改" cancelText="继续编辑" autoClose={false} onClose={() => setDiscard(false)} onConfirm={onClose} /><ConfirmDialog open={overwrite} title="以当前输入替换最新配置？" content="请确认已核对最新成员、通道与期限；下一次保存会使用当前窗口全部内容。" confirmText="采用最新版本继续编辑" cancelText="返回核对" autoClose={false} onClose={() => setOverwrite(false)} onConfirm={() => { if (latest) { setVersion(latest.version); setSaved(latest) } setConflict(false); setOverwrite(false); setError('') }} /></>
  function memberAdd() { try { patch({ members: [...document.members, { id: newOperationId('uuid'), name: '', note: '', template_id: null }] }) } catch (reason) { setError(faceError(reason)) } }
}

export function FaceLibraryConnected() {
  const [libraries, setLibraries] = useState<FaceLibrary[]>([]), [channels, setChannels] = useState<FaceChannel[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<{ id: string; library: FaceLibrary | null } | null>(null), [deleting, setDeleting] = useState<FaceLibrary | null>(null), [busy, setBusy] = useState(false)
  const deleteKey = useRef('')
  const [runtimeRevision, setRuntimeRevision] = useState(0)
  const [runtimeStatus, setRuntimeStatus] = useState<FaceStatus | null>(null)
  const activeSpaces = runtimeStatus?.spaces.filter(space => space.active === true) ?? []
  const activeSpace = activeSpaces.length === 1 ? activeSpaces[0] : undefined
  useEffect(() => { let live = true; setLoading(true); void Promise.all([faceService.libraries(), faceService.channels()]).then(([list, available]) => { if (live) { setLibraries(list.items); setChannels(available.items); setError('') } }).catch(reason => { if (live) setError(faceError(reason)) }).finally(() => { if (live) setLoading(false) }); return () => { live = false } }, [reload])
  async function remove() { if (!deleting) return; setBusy(true); try { await faceService.delete(deleting.id, deleting.version, deleteKey.current); setLibraries(old => old.filter(value => value.id !== deleting.id)); setDeleting(null); setRuntimeRevision(value => value + 1); setNotice('库已删除，历史引用不重写；照片和特征按原到期时间清理。') } catch (reason) { setError(faceError(reason)) } finally { setBusy(false) } }
  return <section aria-label="设备人脸库" className="ui-panel space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">人脸库与关注名单</h2><p className="mt-1 text-xs text-ink-subtle">最多16个人脸库、合计500位成员</p></div><button className="btn-primary min-h-11" disabled={loading || libraries.length >= 16} onClick={() => { try { setEditing({ id: newOperationId('uuid'), library: null }) } catch (reason) { setError(faceError(reason)) } }}>新建人脸库</button></div><FaceRuntimeState revision={runtimeRevision} onStatus={setRuntimeStatus} />
    <div className="flex flex-wrap gap-2"><button className="btn-secondary min-h-11" disabled={loading} onClick={() => setReload(value => value + 1)}>刷新</button><Link className="btn-secondary min-h-11" to="/recognition-history?view=faces">人脸抓拍历史</Link></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{notice && <p role="status" className="text-sm">{notice}</p>}
    {loading ? <p role="status">正在读取设备配置…</p> : !error && !libraries.length ? <p className="py-8 text-center text-sm text-ink-subtle">暂无已保存的人脸库</p> : null}
    <div className="space-y-3">{libraries.map(library => { const registrationCount = library.document.members.filter(member => { const template = library.templates[member.id]; return template && needsRegistration(template, library.document.model, activeSpace) }).length; return <article key={library.id} aria-label={library.document.name} className="rounded-base border border-line p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{library.document.name}</h3><div className="flex gap-2"><button className="btn-secondary min-h-11" onClick={() => setEditing({ id: library.id, library })}>编辑库</button><button className="btn-secondary min-h-11" onClick={() => { try { deleteKey.current = newOperationId('uuid'); setDeleting(library) } catch (reason) { setError(faceError(reason)) } }}>删除库</button></div></div><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><dt>成员</dt><dd>{library.document.members.length} 位成员 · {Object.keys(library.templates).length} 张成员照片</dd></div><div><dt>使用通道</dt><dd>{library.document.channel_ids.map(id => channels.find(channel => channel.id === id)?.name || '名称暂不可用').join('、')}</dd></div><div><dt>有效期与保留</dt><dd>{Date.parse(library.document.valid_until) <= Date.now() ? '名单已过期' : `截至 ${new Date(library.document.valid_until).toLocaleDateString()}`} · 后续上传保留 {library.document.retention_days} 天</dd></div><div><dt>状态</dt><dd>{library.document.match_requested ? '已请求名单匹配，运行状态以上方为准' : '名单匹配未开启'}</dd></div></dl>{registrationCount > 0 && <p className="mt-3 text-sm text-amber-800">{registrationCount} 位成员需要重新登记：模型已更新，请编辑库并重新上传照片；原照片与历史记录按原期限保留。</p>}</article> })}</div>
    {editing && <Editor initial={editing.library} id={editing.id} channels={channels} activeSpace={activeSpace} onClose={() => setEditing(null)} onSaved={library => { setLibraries(old => [...old.filter(value => value.id !== library.id), library]); setEditing(null); setRuntimeRevision(value => value + 1); setNotice('人脸库配置已保存，正在核对运行状态；保存不等于立即生效。') }} />}
    <ConfirmDialog open={!!deleting} title="删除人脸库？" content={`删除「${deleting?.document.name ?? ''}」当前配置；已有历史版本引用不改写，照片按原期限清理。`} busy={busy} autoClose={false} confirmText="确认删除" onConfirm={() => void remove()} onClose={() => setDeleting(null)} />
  </section>
}

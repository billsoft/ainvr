import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ShieldCheck } from 'lucide-react'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { FacePlaceholder, FacePreviewModal, FacePreviewNotice } from './FacePreviewShared'
import { FaceMode } from './FaceConnectedShared'
import { FaceLibraryConnected } from './FaceLibraryConnected'

type Quality = 'qualified' | 'blurred' | 'no-face'
type Space = 'mbf-v1' | 'r50-v1'
interface Member { id: number; name: string; quality: Quality; space: Space }
interface LibraryDraft {
  id: number; name: string; version: number; channels: string[]; expires: string
  retention: string; access: string; space: Space; members: Member[]
}
const qualityText: Record<Quality, string> = { qualified: '合格（模拟）', blurred: '不合格：模糊', 'no-face': '不合格：无人脸' }
const spaces: Record<Space, string> = { 'mbf-v1': '轻量特征空间 MBF · 示例 v1', 'r50-v1': '高精度特征空间 R50 · 示例 v1' }
const emptyDraft = (id: number): LibraryDraft => ({ id, name: '', version: 0, channels: [], expires: '', retention: '30', access: 'admins', space: 'mbf-v1', members: [] })

function LibraryEditor({ initial, onSave, onClose }: { initial: LibraryDraft; onSave: (draft: LibraryDraft) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<LibraryDraft>(() => ({ ...initial, channels: [...initial.channels], members: initial.members.map(member => ({ ...member })) }))
  const [discard, setDiscard] = useState(false)
  const [error, setError] = useState('')
  const [simulateConflict, setSimulateConflict] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [baseVersion, setBaseVersion] = useState(initial.version)
  const memberId = useRef(Math.max(0, ...initial.members.map(member => member.id)) + 1)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const close = () => dirty ? setDiscard(true) : onClose()
  const patch = (change: Partial<LibraryDraft>) => { setDraft(old => ({ ...old, ...change })); setError('') }
  const changeMember = (id: number, change: Partial<Member>) => patch({ members: draft.members.map(member => member.id === id ? { ...member, ...change } : member) })
  const save = () => {
    if (!draft.name.trim()) { setError('请填写库名称。'); return }
    if (!draft.channels.length) { setError('请选择至少一个允许使用的示例通道。'); return }
    if (!draft.expires) { setError('请选择名单有效期。'); return }
    if (draft.members.some(member => !member.name.trim())) { setError('请填写每个成员的名称，或移除空成员。'); return }
    if (simulateConflict || conflict) { setConflict(true); setError('模拟版本冲突：远端版本已变化。输入已保留，未覆盖任何配置。'); return }
    onSave({ ...draft, name: draft.name.trim(), version: baseVersion + 1, members: draft.members.map(member => ({ ...member, name: member.name.trim() })) })
  }
  const needsMigration = draft.members.some(member => member.space !== draft.space)
  return <>
    <FacePreviewModal title={initial.version ? '编辑人脸库草稿' : '新建人脸库草稿'} onClose={close} footer={<>
      <button type="button" className="btn-secondary min-h-11" onClick={close}>取消</button>
      <button type="submit" form="face-library-draft" className="btn-primary min-h-11">保存到本次预览</button>
    </>}>
      <FacePreviewNotice />
      <form id="face-library-draft" data-unsaved={dirty ? 'true' : undefined} className="space-y-4" onSubmit={event => { event.preventDefault(); save() }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span>库名称</span><input className="form-input min-h-11" maxLength={60} value={draft.name} onChange={event => patch({ name: event.target.value })} /></label>
          <label className="space-y-1 text-sm"><span>名单有效期</span><input type="date" className="form-input min-h-11" value={draft.expires} onChange={event => patch({ expires: event.target.value })} /></label>
          <label className="space-y-1 text-sm"><span>身份可见权限（草案）</span><select className="form-input min-h-11" value={draft.access} onChange={event => patch({ access: event.target.value })}><option value="admins">仅授权管理员</option><option value="reviewers">管理员与授权审核员</option></select></label>
          <label className="space-y-1 text-sm"><span>照片与特征保留（草案）</span><select className="form-input min-h-11" value={draft.retention} onChange={event => patch({ retention: event.target.value })}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label>
        </div>
        <fieldset className="rounded-base border border-line p-3"><legend className="px-1 text-sm">允许使用的通道（示例）</legend><div className="flex flex-wrap gap-3">{['示例通道 A · 大门', '示例通道 B · 走廊'].map(channel => <label key={channel} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.channels.includes(channel)} onChange={event => patch({ channels: event.target.checked ? [...draft.channels, channel] : draft.channels.filter(value => value !== channel) })} />{channel}</label>)}</div><p className="text-xs text-ink-subtle">不读取或修改真实通道；权限与范围须由后端接入后验证。</p></fieldset>
        <label className="block space-y-1 text-sm"><span>人脸特征空间</span><select className="form-input min-h-11" value={draft.space} onChange={event => patch({ space: event.target.value as Space })}>{Object.entries(spaces).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <p className="text-xs text-ink-subtle">更换模型需要重新提取并验证特征；旧空间不能混用。预览不执行提取或迁移，不将相似度等同身份确认。</p>
        {needsMigration && <p role="status" className="rounded-base bg-amber-50 p-3 text-sm text-amber-900">迁移待执行：已有成员引用旧空间，保留原版本；正式匹配不可用。</p>}
        <section aria-label="成员草稿" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">成员与导入质量</h3><button type="button" className="btn-secondary min-h-11" disabled={draft.members.length >= 20} onClick={() => patch({ members: [...draft.members, { id: memberId.current++, name: '', quality: 'qualified', space: draft.space }] })}>添加占位成员</button></div>
          <p className="text-xs text-ink-subtle">最多 20 个预览成员，不上传照片。质量选项仅模拟校验；正式入库必须校验原图，修复增强不能证明身份。</p>
          {!draft.members.length && <p className="rounded-base border border-dashed border-line p-4 text-sm text-ink-subtle">暂无成员，可添加占位成员试验质量失败和纠正。</p>}
          {draft.members.map((member, index) => <article key={member.id} className="flex flex-wrap gap-3 rounded-base border border-line p-3" aria-label={`成员 ${index + 1}`}>
            <FacePlaceholder /><div className="min-w-0 flex-1 space-y-2">
              <label className="block text-sm">成员名称 {index + 1}<input className="form-input min-h-11 mt-1" maxLength={40} value={member.name} onChange={event => changeMember(member.id, { name: event.target.value })} /></label>
              <label className="block text-sm">图片质量 {index + 1}<select className="form-input min-h-11 mt-1" value={member.quality} onChange={event => changeMember(member.id, { quality: event.target.value as Quality })}>{Object.entries(qualityText).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
              <p className="text-xs text-ink-subtle">{member.quality === 'qualified' ? '合格仅为模拟输入；特征尚未提取。' : '不可用于匹配：需更换合格照片。'} {member.space !== draft.space ? '旧模型空间：待迁移。' : ''}</p>
            </div><button type="button" className="btn-secondary min-h-11 self-end" aria-label={`移除成员 ${index + 1}`} onClick={() => patch({ members: draft.members.filter(value => value.id !== member.id) })}>移除</button>
          </article>)}
        </section>
        <div className="rounded-base bg-surface-page p-3 text-xs leading-5 text-ink-subtle"><strong>引用与保留</strong><p>照片与特征计划放入证据存储，仅保存引用；名单保留版本与使用范围。历史记录引用发生时的库版本，不随编辑重写；证据过期显示不可用，不虚构图片、不追溯生成告警。</p><p>身份及操作审计必须由后台授权；当前没有真实照片、向量或生产权限变更。</p></div>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={simulateConflict} onChange={event => setSimulateConflict(event.target.checked)} />下次保存模拟版本冲突</label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {conflict && <div className="rounded-base border border-amber-200 p-3 text-sm"><p>基于示例 v{baseVersion} 编辑，模拟最新 v{baseVersion + 1}。继续前请核对全部草稿内容。</p><button type="button" className="btn-secondary min-h-11 mt-2" onClick={() => { setBaseVersion(value => value + 1); setConflict(false); setSimulateConflict(false); setError('') }}>按新版本继续（保留输入）</button></div>}
      </form>
    </FacePreviewModal>
    <ConfirmDialog open={discard} title="放弃未保存的人脸库修改？" content="仅放弃本窗口的未保存输入。已经保存到本次预览的草稿不受影响。" confirmText="放弃修改" cancelText="继续编辑" autoClose={false} onClose={() => setDiscard(false)} onConfirm={onClose} />
  </>
}

export function FaceLibraryPreview({ previewOnly = false }: { previewOnly?: boolean }) {
  return <FaceMode previewOnly={previewOnly} preview={<FaceLibraryDemo />}><FaceLibraryConnected /></FaceMode>
}
function FaceLibraryDemo() {
  const [drafts, setDrafts] = useState<LibraryDraft[]>([])
  const [editing, setEditing] = useState<LibraryDraft | null>(null)
  const [message, setMessage] = useState('')
  const [sample, setSample] = useState(false)
  const nextId = useRef(1)
  return <section className="ui-panel space-y-4 p-4 sm:p-5" aria-label="人脸库与关注名单设计预览">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">人脸库与关注名单</h2><p className="mt-1 text-xs text-ink-subtle">管理库、成员质量、特征版本与使用范围</p></div><button type="button" className="btn-primary min-h-11" onClick={() => { setMessage(''); setEditing(emptyDraft(nextId.current++)) }}><Plus size={16} aria-hidden />新建人脸库草稿</button></div>
    <FacePreviewNotice />
    <div className="flex flex-wrap items-center gap-2"><button type="button" className="btn-secondary min-h-11" disabled>正式启用（后台未接入）</button><Link className="btn-secondary min-h-11" to="/recognition-history?view=faces">查看抓拍设计预览</Link><button type="button" className="btn-secondary min-h-11" aria-expanded={sample} onClick={() => setSample(value => !value)}>{sample ? '隐藏示例库' : '查看示例库布局'}</button></div>
    {sample && <article aria-label="只读示例库" className="rounded-base border border-dashed border-amber-300 bg-amber-50/40 p-4"><div className="flex flex-wrap gap-3"><FacePlaceholder /><div className="space-y-1 text-sm"><h3 className="font-semibold">示例库 · 访客关注（只读）</h3><p>示例成员 01 · 图片合格（模拟） · 特征空间 MBF v1</p><p>库版本 v3 · 仅授权管理员 · 示例通道 A</p><p>保留 30 天 · 有效期 2026-12-31（示例）</p><p className="text-xs text-ink-subtle">引用 demo-library-v3 / demo-photo-01 · 无真实照片或向量，不加入下方草稿。</p></div></div></article>}
    <div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} aria-hidden />本次页面草稿 <span className="text-ink-subtle">{drafts.length} 个 · 均未启用</span></div>
    {message && <p role="status" className="text-sm text-primary-600">{message}</p>}
    {!drafts.length && <div className="rounded-base border border-dashed border-line p-8 text-center"><h3 className="text-sm font-medium">暂无内存草稿</h3><p className="mt-2 text-xs text-ink-subtle">真实人脸库尚未接入，此处不表示设备图库为空。可新建草稿验证流程。</p></div>}
    <div className="space-y-3">{drafts.map(draft => <article key={draft.id} aria-label={draft.name} className="rounded-base border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">{draft.name} <span className="text-xs font-normal text-amber-800">仅预览 · 未启用</span></h3><p className="mt-1 text-xs text-ink-subtle">草稿 v{draft.version} · {draft.members.length} 位占位成员 · {spaces[draft.space]}</p></div><button type="button" className="btn-secondary min-h-11" onClick={() => { setMessage(''); setEditing(draft) }}>编辑草稿</button></div>
      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="text-ink-subtle">质量与版本</dt><dd className="mt-1">{draft.members.filter(member => member.quality === 'qualified').length} 张模拟合格 / {draft.members.length} 张占位图 · 特征尚未提取{draft.members.some(member => member.space !== draft.space) && ' · 旧空间待迁移'}</dd></div><div><dt className="text-ink-subtle">身份权限与允许通道（草案）</dt><dd className="mt-1">{draft.access === 'admins' ? '仅授权管理员' : '管理员与授权审核员'} · {draft.channels.join('、')}</dd></div><div><dt className="text-ink-subtle">有效期与保留（草案）</dt><dd className="mt-1">截至 {draft.expires} · 照片/特征保留 {draft.retention} 天</dd></div><div><dt className="text-ink-subtle">历史引用与审计</dt><dd className="mt-1">preview-library-{draft.id}@v{draft.version} · 本次内存编辑，无后台审计；历史版本引用不重写。</dd></div></dl>
    </article>)}</div>
    {editing && <LibraryEditor initial={editing} onClose={() => setEditing(null)} onSave={draft => { setDrafts(old => [...old.filter(item => item.id !== draft.id), draft]); setEditing(null); setMessage('已保存到本次预览；设备配置未改变，刷新或离开页面后清空。') }} />}
  </section>
}

import { useEffect, useState } from 'react'
import { toast } from '@/store/toast'
import { configService, type ConfigDocument, type PgInfo } from '@/api/configService'
import { Section, Field, inputCls } from './fields'

interface Props {
  aiServiceDoc: ConfigDocument | undefined
  onSavePartial: (service: string, group: string, name: string, overrides: Record<string, unknown>, description?: string) => Promise<void>
}

/** Full URIs round-trip SRV, IPv6 and replica sets unchanged. Existing secrets
 * are never sent to this form. Empty replacement fields preserve references. */
export function DatabaseConfigForm({ aiServiceDoc, onSavePartial }: Props) {
  const snap = (aiServiceDoc?.config.snapshot_store ?? {}) as Record<string, unknown>
  const [uri, setUri] = useState('')
  const [db, setDb] = useState(String(snap.db_name ?? 'ai_snapshots'))
  const [readonlyUser, setReadonlyUser] = useState(String(snap.mongo_readonly_username ?? ''))
  const [readonlyPass, setReadonlyPass] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pgInfo, setPgInfo] = useState<PgInfo | null>(null)
  const [pgError, setPgError] = useState('')
  useEffect(() => {
    let active = true
    void configService.getPgInfo().then(value => { if (active) setPgInfo(value) })
      .catch(error => { if (active) setPgError(error.message || '加载失败') })
    return () => { active = false }
  }, [])
  async function save() {
    const replacement = uri.trim()
    if (replacement && !/^mongodb(?:\+srv)?:\/\/\S+$/.test(replacement)) {
      toast.error('请输入完整的 AI识别历史库连接串'); return
    }
    if (!db.trim()) { toast.error('请填写数据库名'); return }
    setSaving(true)
    try {
      await onSavePartial('ai-service', 'system', 'settings', { snapshot_store: {
        ...snap, db_name: db.trim(), mongo_readonly_username: readonlyUser.trim() || null,
        ...(replacement ? { mongo_uri: replacement } : {}),
        ...(readonlyPass ? { mongo_readonly_password: readonlyPass } : {}),
      } })
      setUri(''); setReadonlyPass(''); setDirty(false)
      toast.success('已保存并应用')
    } catch (error) { toast.error(error instanceof Error ? error.message : '更新失败') }
    finally { setSaving(false) }
  }
  return <div className="space-y-5" data-unsaved={dirty} onChange={() => setDirty(true)}>
    <Section title="参数库" hint="配置中心自身数据库。连接参数通过部署环境修改，不在本页修改；修改后需要重启 Web 后端，重启前应确认新参数库包含现有配置。">
      {pgError ? <p role="alert">{pgError}</p> : !pgInfo ? <p>加载中…</p> : <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt>地址</dt><dd>{pgInfo.host}</dd><dt>端口</dt><dd>{pgInfo.port}</dd>
        <dt>数据库</dt><dd>{pgInfo.database}</dd><dt>用户</dt><dd>{pgInfo.user}</dd>
        <dt>连接状态</dt><dd>{pgInfo.connected ? '正常' : '异常'}</dd>
      </dl>}
    </Section>
    <Section title="AI识别历史库（识别快照存储）" hint="修改连接后保存，系统会验证连接并自动重启 AI 服务。账号须提前创建；密码不会回显。">
      <p className="text-sm">写入连接：{snap.mongo_uri ? '已配置（密钥保护）' : '使用服务默认配置'}</p>
      <p className="text-sm text-ink-subtle">使用本机随系统部署的 AI识别历史库时，AI 写入地址应为 127.0.0.1:27017；数据库仅允许本机访问，不能填写开发板的局域网 IP。远程数据库才使用远端地址。</p>
      <Field label="替换写入连接串" hint="留空保留原连接；支持 SRV、多节点、IPv6 及完整连接选项。仅修改下方字段不会重写连接串。">
        <input aria-label="替换写入连接串" type="password" autoComplete="new-password" value={uri} onChange={e => setUri(e.target.value)} className={inputCls} placeholder="mongodb://用户:密码@主机:端口/数据库?authSource=认证库" />
      </Field>
      <Field label="数据库名"><input aria-label="数据库名" value={db} onChange={e => setDb(e.target.value)} className={inputCls} /></Field>
      <details className="rounded-base border border-line p-4">
        <summary>外部只读查询账号（不用于 AI 写入）</summary>
        <p className="my-3 text-xs text-ink-subtle">只读凭据同样属于敏感信息，只应交给获授权的查询方。本页不创建或修改数据库账号本身。</p>
        <Field label="只读账号"><input aria-label="只读账号" value={readonlyUser} onChange={e => setReadonlyUser(e.target.value)} className={inputCls} /></Field>
        <Field label="替换只读密码" hint="留空保留已保存密码，不回显历史密码。"><input aria-label="替换只读密码" type="password" autoComplete="new-password" value={readonlyPass} onChange={e => setReadonlyPass(e.target.value)} className={inputCls} /></Field>
      </details>
      <button type="button" onClick={save} disabled={saving || !dirty} className="rounded-base bg-primary px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? '保存并应用中…' : '保存并应用'}</button>
    </Section>
  </div>
}

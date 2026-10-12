/**
 * "识别历史"页 · 检测接口示例弹窗（2026-09-17）。
 *
 * 给外部系统开发者（比如人脸库比对程序的开发方）一份能直接改改连接信息
 * 就跑的查询示例代码——直接连只读 MongoDB 账号，不经过控制台/AI微服务。
 * 代码本身在 apiExampleCode.ts（纯函数，方便单测），这个文件只管弹窗外壳
 * + 拉连接信息 + 复制。
 *
 * 故意不做"点背景/按 Esc 关闭"——这是给人对着抄代码的参考窗口，不是需要
 * 确认的临时提示，误触关闭比多点一次关闭按钮更烦人。
 *
 * 连接信息（只读账号）现读 ai-service 的配置文档，不是这个组件自己攒的
 * 静态值；账号和库名来自数据库配置，地址与密码使用占位符，避免泄露凭据。
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { configService } from '@/api/configService'
import { CodeBlock } from '@/components/common/CodeBlock'
import { CopyButton } from '@/components/common/CopyButton'
import { buildMongoshExample, buildPythonExample, buildSchemaExample, type ApiExampleParams } from './apiExampleCode'

interface Props {
  open: boolean
  onClose: () => void
  channelId: string
  channelName: string
  /** Unix 秒级时间戳（可带小数），跟页面查询用的是同一个换算结果 */
  fromTs: number
  toTs: number
  /** 0~1，0 表示不过滤 */
  minConfidence: number
}

type TabKey = 'python' | 'mongosh' | 'schema'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'python', label: 'Python' },
  { key: 'mongosh', label: 'mongosh' },
  { key: 'schema', label: '结果字段说明' },
]

interface ConnInfo {
  host: string
  port: number
  dbName: string
  user: string
  pass: string
}

export function ApiExampleDialog({ open, onClose, channelId, channelName, fromTs, toTs, minConfidence }: Props) {
  const [tab, setTab] = useState<TabKey>('python')
  const [conn, setConn] = useState<ConnInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setLoadError(null)
    configService.getDocument('ai-service', 'system', 'settings')
      .then((doc) => {
        const snap = (doc.config.snapshot_store ?? {}) as Record<string, unknown>
        setConn({
          host: 'YOUR_MONGODB_HOST',
          port: typeof snap.mongo_port === 'number' && Number.isFinite(snap.mongo_port) ? snap.mongo_port : 27017,
          dbName: typeof snap.db_name === 'string' && snap.db_name ? snap.db_name : 'ai_snapshots',
          user: typeof snap.mongo_readonly_username === 'string' ? snap.mongo_readonly_username : '',
          pass: snap.mongo_readonly_password ? 'YOUR_READONLY_PASSWORD' : '',
        })
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : '加载连接信息失败'))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  const params: ApiExampleParams | null = conn
    ? {
        mongoHost: conn.host,
        mongoPort: conn.port,
        dbName: conn.dbName,
        readonlyUser: conn.user || '<尚未设置，先去 AI服务配置页填只读账号>',
        readonlyPassword: conn.pass || '<尚未设置，先去 AI服务配置页填只读密码>',
        channelId,
        channelName,
        fromTs,
        toTs,
        minConfidence,
      }
    : null

  const code = params
    ? tab === 'python'
      ? buildPythonExample(params)
      : tab === 'mongosh'
        ? buildMongoshExample(params)
        : buildSchemaExample(params)
    : ''

  // schema 标签给的是带 `//` 注释的伪 JSON（真 JSON 语法不允许注释），
  // 用 json 语法高亮会把注释整段标红当成语法错误——用 javascript 语法刚好
  // 能认字符串/数字/注释/大括号，效果跟真 JSON 高亮没区别
  const codeLanguage = tab === 'python' ? 'python' : 'javascript'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="检测接口示例"
    >
      <div className="flex max-h-[85vh] w-[720px] max-w-[92vw] flex-col rounded-panel bg-surface shadow-modal">
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h3 className="text-base font-semibold text-ink">检测接口示例</h3>
            <p className="mt-0.5 text-xs text-ink-subtle">
              给外部系统对接用——直接连 AI识别历史库只读账号查询识别结果，不经过本控制台
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-base p-1.5 text-ink-faint hover:bg-surface-page hover:text-ink"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-line px-5 pt-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={[
                'rounded-t-base px-3 py-1.5 text-sm font-medium transition-colors',
                tab === t.key
                  ? 'border border-b-0 border-line bg-surface text-primary'
                  : 'text-ink-subtle hover:text-ink',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden p-5 pt-4">
          {loading ? (
            <p className="text-sm text-ink-faint">加载连接信息…</p>
          ) : loadError ? (
            <p className="text-sm text-danger">{loadError}</p>
          ) : (
            <>
                <p className="mb-3 rounded-base border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
                  请在系统配置的数据库分类维护只读账号。示例不包含真实密码，请向管理员获取连接地址和凭据。
                </p>
              <div className="relative h-full min-h-0">
                <CopyButton
                  value={code}
                  className="absolute right-2 top-2 z-10 border border-line bg-surface shadow-sm hover:bg-surface-page"
                />
                <CodeBlock
                  code={code}
                  language={codeLanguage}
                  testId="api-example-code"
                  className="h-full max-h-[50vh] overflow-auto rounded-base border border-line bg-surface-page p-3 pt-10 font-mono text-xs leading-relaxed"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

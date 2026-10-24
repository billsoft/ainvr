import { Section, Field, inputCls } from './fields'
/**
 * 系统配置 · AI微服务配置（2026-09-18，5分类改版）
 *
 * 合并了两个此前分散在不同页面的"访问密钥"：
 * - backend/system/settings.aiService.apiKey——backend 调用 ai-service
 *   时带的出站凭据。
 * - ai-service/system/settings.server.api_key——ai-service 自己校验
 *   入站请求用的凭据。
 * 两者概念上必须是同一个值，此前却要跑两个页面各填一遍，容易漏改一边
 * 变成"backend 拿着旧密钥去敲门，ai-service 拿新密钥核对，永远 401"。
 * 页面只有一个密钥输入框；批量保存清空 backend 的旧覆盖值，
 * 新密钥仅进入 AI 服务的加密密钥源，backend 代理读取同一密钥源。
 *
 * 两份文档各自独立的"已设置"状态互不感知（前端从来看不到明文，没法
 * 判断两边是不是真的一致）——不touch 这个字段时，两份各自保留原样，
 * 不强行同步；只有用户主动输入新值或点"清除"时才会把两份改成同一个值，
 * 这是唯一能真正保证同步的时机。
 */
import { useState } from 'react'
import { systemService } from '@/api/systemService'
import { toast } from '@/store/toast'
import type { ConfigDocument, ConfigChange } from '@/api/configService'
import { describeAiService } from '@/utils/capabilityText'

interface Props {
  onSaveBatch: (changes: ConfigChange[]) => Promise<void>
  backendDoc: ConfigDocument | undefined
  aiServiceDoc: ConfigDocument | undefined
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}




type TestResult = Awaited<ReturnType<typeof systemService.testAiConnection>>
const TEST_REASON_LABEL: Record<NonNullable<TestResult['reason']>, string> = {
  unauthorized: '密钥无效',
  unreachable: '服务不可达',
  timeout: '响应超时',
  error: '返回异常',
}

export function AiServiceConfigForm({ backendDoc, aiServiceDoc, onSaveBatch }: Props) {
  const backendConfig = backendDoc?.config ?? {}
  const ai = (backendConfig.aiService ?? {}) as Record<string, unknown>
  const aiServiceConfig = aiServiceDoc?.config ?? {}
  const server = (aiServiceConfig.server ?? {}) as Record<string, unknown>

  const [aiBaseUrl, setAiBaseUrl] = useState(str(ai.baseUrl))
  const [aiPollMs, setAiPollMs] = useState(String(num(ai.pollIntervalMs, 5000)))
  const [keyInput, setKeyInput] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const originalBackendKey = str(ai.apiKey)
  const originalServerKey = str(server.api_key)
  const keyAlreadySet = !!(originalBackendKey || originalServerKey || ai.aiApiKeySet)

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await systemService.testAiConnection({
        baseUrl: aiBaseUrl.trim() || undefined,
        apiKey: clearKey ? '' : keyInput || undefined,
      })
      setTestResult(result)
    } catch (e: any) {
      setTestResult({ ok: false, reason: 'error', message: e.message || '测试请求失败' })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (aiBaseUrl.trim() && !/^https?:\/\/[^\s]+$/.test(aiBaseUrl.trim())) { toast.error('请输入有效的 HTTP 服务地址'); return }
    if (!Number.isFinite(Number(aiPollMs)) || Number(aiPollMs) < 1000 || Number(aiPollMs) > 60000) { toast.error('刷新间隔应为 1000–60000 毫秒'); return }
    setSaving(true)
    try {

        const changes: ConfigChange[] = [{ service: 'backend', group: 'system', name: 'settings', config: {
          aiService: { ...ai, baseUrl: aiBaseUrl.trim(), pollIntervalMs: Number(aiPollMs),
            // Canonical key is encrypted on the AI document; never copy plaintext to backend.
            ...(keyInput || clearKey ? { apiKey: '' } : {}) },
        } }]
        if (keyInput || clearKey) changes.push({ service: 'ai-service', group: 'system', name: 'settings', config: {
          server: { ...server, api_key: clearKey ? null : keyInput },
        } })
        await onSaveBatch(changes)
        setKeyInput(''); setClearKey(false); setDirty(false)
        toast.success('已保存并应用')
    } catch (e: any) {
      toast.error(e.message || '更新失败，请检查服务状态')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5" data-unsaved={dirty}>
      <Section
        title="AI 识别服务连接"
        hint="本机一体化部署时保持默认即可。地址与鉴权在后续请求生效，无需重启识别通道；保存不会搬迁或重新启动远端服务"
      >
        <Field label="服务地址">
          <input type="text" value={aiBaseUrl}
            onChange={(e) => { setAiBaseUrl(e.target.value); setDirty(true) }}
            className={inputCls} placeholder="留空：使用本机 AI 服务，如 http://192.168.1.10:8000" />
        </Field>
        <Field label="访问密钥" hint="backend 调用 ai-service、ai-service 校验来访请求，两边用的是同一把钥匙——这里改一次，两边一起生效">
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              disabled={clearKey}
              autoComplete="off"
              onChange={(e) => { setKeyInput(e.target.value); setDirty(true) }}
              className={inputCls + ' flex-1 disabled:bg-surface-page disabled:text-ink-faint'}
              placeholder={
                clearKey
                  ? '保存后清除已保存的密钥（关闭鉴权）'
                  : keyAlreadySet
                    ? '已设置（留空表示不修改）'
                    : '未设置（无需鉴权可留空）'
              }
            />
            {keyAlreadySet && !clearKey && (
              <button type="button"
                onClick={() => { setClearKey(true); setKeyInput(''); setDirty(true) }}
                className="shrink-0 rounded-base border border-line px-3 text-xs text-ink-subtle hover:bg-surface-page">
                清除密钥
              </button>
            )}
            {clearKey && (
              <button type="button"
                onClick={() => { setClearKey(false); setDirty(true) }}
                className="shrink-0 rounded-base border border-line px-3 text-xs text-ink-subtle hover:bg-surface-page">
                撤销
              </button>
            )}
          </div>
        </Field>
        <Field label="状态刷新间隔（毫秒）">
          <input type="number" min={1000} max={60000} step={1000} value={aiPollMs}
            onChange={(e) => { setAiPollMs(e.target.value); setDirty(true) }}
            className={inputCls} />
        </Field>
        {testResult && (
          <div className={`rounded-base border p-3 text-xs ${testResult.ok ? 'border-success-200 bg-success-50 text-success-700' : 'border-danger-200 bg-danger-50 text-danger-700'}`}>
            {testResult.ok
              ? `连接成功${describeAiService(testResult.health) ? `：${describeAiService(testResult.health)}` : ''}`
              : `连接失败：${testResult.reason ? TEST_REASON_LABEL[testResult.reason] : '未知错误'}${testResult.message ? `（${testResult.message}）` : ''}`}
          </div>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={handleTest} disabled={testing}
            className="rounded-base border border-line bg-surface px-4 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-surface-hover disabled:opacity-50">
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" onClick={handleSave} disabled={saving || !dirty}
            className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-600 disabled:opacity-50">
            {saving ? '保存并应用中…' : '保存并应用'}
          </button>
        </div>
      </Section>
    </div>
  )
}

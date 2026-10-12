// 统一的 API 请求封装：合并原来 httpChannelService.ts / systemService.ts
// 里两份重复的 request()，顺带在这里接入鉴权 token 与 401 处理。
import type { LicenseStateName } from '@/types/license'

const API_BASE = '/api'

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('srs-console-token')
  const headers: Record<string, string> = {
    // 只在真的带 body 时才声明 Content-Type: application/json——不带 body
    // 的 DELETE/GET（比如清空识别历史）之前无条件带这个头，后端 Fastify
    // 的默认 JSON body 解析器一看到这个 content-type 就要求 body 非空，
    // 空 body 直接在解析层被拒（FST_ERR_CTP_EMPTY_JSON_BODY / 400），
    // 请求根本到不了路由处理函数——2026-09-10 生产复现：清空按钮点了
    // 没反应，报错就是这条，之前用 curl 验证过这条链路但没带这个头，
    // 没能复现出来，是验证覆盖面的疏漏。
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }
  if (token) headers['X-Console-Token'] = token

  const configRequest = path.startsWith('/license/') || path.startsWith('/v1/config/') || ['/settings', '/settings/password', '/auth/login'].includes(path)
  const res = await fetch(`${API_BASE}${path}`, {
    ...init, signal: init?.signal ?? (configRequest ? AbortSignal.timeout(15000) : undefined), headers,
  })

  if (res.status === 401) {
    // 触发登出：清掉本地 token、标记未登录，AuthGate 会据此重新展示登录页。
    // 用动态 import 避免 store/auth.ts ⇄ httpClient.ts 之间的循环依赖。
    void import('@/store/auth').then(({ useAuthStore }) => useAuthStore.getState().handleUnauthorized())
  }

  if (!res.ok && res.status !== 204) {
    let msg = `HTTP ${res.status}`
    let detail: unknown
    // license BFF/门控错误体是 {code: "LICENSE_*", message, state?, reason?}；
    // 字符串业务码挂到 err.code 供上层精细处理，门控类 503 另上报全局 store。
    let businessCode: string | undefined
    let gateState: string | undefined
    let gateReason: string | undefined
    try {
      const body = await res.json()
      if (typeof body.code === 'string') {
        businessCode = body.code
        gateState = typeof body.state === 'string' ? body.state : undefined
        gateReason = typeof body.reason === 'string' ? body.reason : undefined
      }
      // console 自己路由的错误体是 {error: "字符串"}；ai-service 经代理
      // 透传过来的错误体是 {error: {code, message}}（嵌套对象）——不区分
      // 会把 msg 设成对象，Error() 构造时字符串化成 "[object Object]"，
      // 调用方看到的错误提示全是这四个字，且丢失了原始 code/message 供
      // 上层做更精细的处理（比如 422 时按 message 内容弱映射回向导某一步）。
      detail = body.error
      if (typeof body.error === 'string') msg = body.error
      else if (typeof body.detail === 'string') msg = body.detail
      else if (body.error && typeof body.error === 'object' && 'message' in body.error) {
        msg = String((body.error as { message: unknown }).message)
        if (!businessCode && typeof body.error.code === 'string') businessCode = body.error.code
      }
      if (businessCode && typeof body.message === 'string') msg = body.message
      if (body.code === 409) msg = (typeof body.error === 'string' ? body.error : msg) || '资源冲突'
    } catch {
      // ignore
    }
    const err = new Error(msg) as Error & { status: number; code?: number | string; detail?: unknown }
    err.status = res.status
    err.detail = detail
    err.code = businessCode ?? (res.status === 409 ? 'CONFLICT' : undefined)
    if (businessCode === 'LICENSE_REQUIRED' || businessCode === 'LICENSE_SERVICE_UNAVAILABLE') {
      // 全局门控拦截：驱动 AppLayout 的阻断层。动态 import 避免循环依赖。
      void import('@/store/license').then(({ useLicenseStore }) =>
        useLicenseStore.getState().reportGateBlock({
          code: businessCode as 'LICENSE_REQUIRED' | 'LICENSE_SERVICE_UNAVAILABLE',
          state: gateState as LicenseStateName | undefined,
          reason: gateReason,
        }),
      )
    }
    throw err
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** 带鉴权头拉二进制（识别历史页面的截图用）——<img src> 标签没法附带自定义
 * 请求头，认证图片只能走 fetch 手动带 token + 转成 blob object URL 这条路，
 * 不能直接把接口地址当 src 用。404（图片已被淘汰）时返回 null，不抛错，
 * 调用方渲染占位图即可，不需要 try/catch。 */
export async function requestBlob(path: string): Promise<Blob | null> {
  const token = localStorage.getItem('srs-console-token')
  const headers: Record<string, string> = {}
  if (token) headers['X-Console-Token'] = token

  const res = await fetch(`${API_BASE}${path}`, { headers })
  if (res.status === 401) {
    void import('@/store/auth').then(({ useAuthStore }) => useAuthStore.getState().handleUnauthorized())
    return null
  }
  if (!res.ok) return null
  return res.blob()
}

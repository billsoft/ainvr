import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request, requestBlob } from '@/api/httpClient'

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch
}

type RequestError = Error & { status: number; detail?: unknown }

describe('httpClient.request 错误结构解析', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('console 自己路由的扁平字符串错误：message 直接就是这个字符串', async () => {
    mockFetchOnce(400, { code: 400, error: '参数错误' })
    await expect(request('/x')).rejects.toMatchObject({
      message: '参数错误',
      status: 400,
      detail: '参数错误',
    })
  })

  it('ai-service 经代理透传的嵌套对象错误：message 取 error.message，不是 "[object Object]"', async () => {
    mockFetchOnce(422, { error: { code: 'invalid_field', message: '不支持修改的字段: [\'id\']' } })
    let err: RequestError | undefined
    try {
      await request('/x')
    } catch (e) {
      err = e as RequestError
    }
    expect(err?.message).toBe("不支持修改的字段: ['id']")
    expect(err?.message).not.toContain('[object Object]')
    // 原始结构保留在 .detail，供调用方做更精细的处理（比如 422 时按
    // message 内容弱映射回向导的某一步），不是只暴露扁平的 .message
    expect(err?.detail).toEqual({ code: 'invalid_field', message: "不支持修改的字段: ['id']" })
  })
})

describe('httpClient.request 不带 body 的请求不能声明 Content-Type: application/json', () => {
  // 2026-09-10 生产复现：清空识别历史点了报 400 Bad Request——根因是这里
  // 无条件给每个请求都带 Content-Type: application/json，后端 Fastify 的
  // 默认 JSON body 解析器一看到这个 content-type 就要求 body 非空，DELETE
  // 这类不带 body 的请求会在解析层被直接拒绝（FST_ERR_CTP_EMPTY_JSON_BODY），
  // 请求根本到不了路由处理函数。这不是清空识别历史一个功能的问题——
  // snapshotService 的单条删除/按范围删除、httpAiChannelService 的删除
  // AI 通道、httpChannelService 的删除 SRS 通道，全部复用这同一个
  // request()，全部会中招，这里在最底层锁死，一次覆盖所有调用点。
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('DELETE 不带 body 时不发送 Content-Type 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request('/ai/channels/cam01/snapshots', { method: 'DELETE' })
    const [, init] = fetchMock.mock.calls[0]!
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('带 body 的请求（POST/PUT）照常声明 Content-Type: application/json', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request('/ai/channels/cam01/config', { method: 'PUT', body: JSON.stringify({ snapshot: { max_count: 1 } }) })
    const [, init] = fetchMock.mock.calls[0]!
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('调用方显式传了 Content-Type 时不被这里的判断覆盖掉', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await request('/x', { method: 'DELETE', headers: { 'Content-Type': 'text/plain' } })
    const [, init] = fetchMock.mock.calls[0]!
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain')
  })
})

describe('httpClient.requestBlob（识别历史截图用——<img src> 带不了鉴权头，只能手动 fetch）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('200 时返回 Blob', async () => {
    const fakeBlob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' })
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, blob: async () => fakeBlob,
    }) as unknown as typeof fetch

    const result = await requestBlob('/ai/channels/cam01/snapshots/img-1/image')
    expect(result).toBe(fakeBlob)
  })

  it('404（记录已被淘汰）时返回 null，不抛错——调用方不需要 try/catch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 404,
    }) as unknown as typeof fetch

    const result = await requestBlob('/ai/channels/cam01/snapshots/img-gone/image')
    expect(result).toBeNull()
  })

  it('本地存了 token 时会带上 X-Console-Token 请求头', async () => {
    localStorage.setItem('srs-console-token', 'abc123')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, blob: async () => new Blob([]),
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await requestBlob('/ai/channels/cam01/snapshots/img-1/image')
    const [, init] = fetchMock.mock.calls[0]!
    expect((init.headers as Record<string, string>)['X-Console-Token']).toBe('abc123')
  })
})

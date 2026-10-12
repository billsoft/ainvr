import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRequest = vi.fn()
vi.mock('@/api/httpClient', () => ({ request: (...args: unknown[]) => mockRequest(...args) }))

import { createHttpAiChannelService } from '@/api/httpAiChannelService'

describe('httpAiChannelService.update() 的字段白名单', () => {
  beforeEach(() => {
    mockRequest.mockReset()
  })

  it('inference_fps 必须能透传——回归：曾被白名单漏掉，编辑改帧率保存后从未生效', async () => {
    mockRequest.mockResolvedValue({})
    const service = createHttpAiChannelService()
    await service.update('cam01', { inference_fps: 10 } as any)

    const [, opts] = mockRequest.mock.calls[0]!
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.inference_fps).toBe(10)
  })

  it('仍然过滤掉白名单外的字段（例如 id），不完全依赖调用方守规矩', async () => {
    mockRequest.mockResolvedValue({})
    const service = createHttpAiChannelService()
    await service.update('cam01', { id: 'should-not-be-sent', name: 'x' } as any)

    const [, opts] = mockRequest.mock.calls[0]!
    const body = JSON.parse((opts as RequestInit).body as string)
    expect('id' in body).toBe(false)
    expect(body.name).toBe('x')
  })

  it('snapshot 必须能透传——识别历史页"改上限/去开启归档"靠这条patch，漏白名单会静默无效', async () => {
    mockRequest.mockResolvedValue({})
    const service = createHttpAiChannelService()
    await service.update('cam01', { snapshot: { max_count: 500 } } as any)

    const [, opts] = mockRequest.mock.calls[0]!
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.snapshot).toEqual({ max_count: 500 })
  })
})

import { createMockChannelService } from '@/api/channelService'
import { mockChannels } from '@/mock/channels'

function fresh() {
  return createMockChannelService(mockChannels)
}
const input = {
  name: '测试通道',
  description: '单测',
  upstream: { protocol: 'rtmp' as const, app: 'live', stream: 'test_stream' },
  downstream: {
    protocols: ['flv' as const, 'hls' as const],
    primary: 'flv' as const,
  },
}

describe('mock channelService CRUD', () => {
  it('list 返回种子数据副本（修改不影响内部状态）', async () => {
    const svc = fresh()
    const arr = await svc.list()
    expect(arr).toHaveLength(5)
    arr[0]!.name = '被篡改'
    const again = await svc.list()
    expect(again[0]!.name).not.toBe('被篡改')
  })

  it('list 支持按名称/描述/流名模糊搜索（大小写不敏感）', async () => {
    const svc = fresh()
    expect((await svc.list({ search: '大门' })).map((c) => c.id)).toEqual(['ch-001'])
    expect((await svc.list({ search: 'CAM_BACK' })).map((c) => c.id)).toEqual(['ch-002'])
    expect((await svc.list({ search: '例会' })).map((c) => c.id)).toEqual(['ch-003'])
    expect(await svc.list({ search: '不存在' })).toHaveLength(0)
    expect((await svc.list({ search: '  大门  ' })).length).toBe(1)
  })

  it('get 命中返回副本，未命中返回 null', async () => {
    const svc = fresh()
    expect((await svc.get('ch-001'))?.name).toBe('大门摄像头')
    expect(await svc.get('ch-999')).toBeNull()
  })

  it('create 生成递增 id、默认离线状态、时间戳', async () => {
    const svc = fresh()
    const ch = await svc.create(input)
    expect(ch.id).toBe('ch-006')
    expect(ch.status.online).toBe(false)
    expect(ch.status.viewerCount).toBe(0)
    expect(ch.createdAt).toBe(ch.updatedAt)
    expect((await svc.get('ch-006'))?.name).toBe('测试通道')
  })

  it('create 之后 id 持续递增（删除不影响序号）', async () => {
    const svc = fresh()
    const a = await svc.create(input)
    await svc.remove(a.id)
    const b = await svc.create(input)
    expect(b.id).toBe('ch-007')
  })

  it('update 浅合并 upstream/downstream 且更新 updatedAt', async () => {
    const svc = fresh()
    const before = (await svc.get('ch-001'))!
    await new Promise((r) => setTimeout(r, 5))
    const after = await svc.update('ch-001', {
      name: '改名了',
      downstream: { protocols: ['hls'], primary: 'hls' },
    })
    expect(after.name).toBe('改名了')
    expect(after.downstream).toEqual({ protocols: ['hls'], primary: 'hls' })
    // 未提交 patch 的 upstream 保持不变
    expect(after.upstream).toEqual(before.upstream)
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    )
  })

  it('update/remove 不存在的 id 抛错', async () => {
    const svc = fresh()
    await expect(svc.update('ch-999', { name: 'x' })).rejects.toThrow('通道不存在')
    await expect(svc.remove('ch-999')).rejects.toThrow('通道不存在')
    await expect(svc.kick('ch-999')).rejects.toThrow('通道不存在')
  })

  it('remove 删除后 list 不再包含', async () => {
    const svc = fresh()
    await svc.remove('ch-002')
    const arr = await svc.list()
    expect(arr).toHaveLength(4)
    expect(arr.map((c) => c.id)).not.toContain('ch-002')
  })

  it('kick 将在线通道置为离线（mock 语义）', async () => {
    const svc = fresh()
    expect((await svc.get('ch-001'))!.status.online).toBe(true)
    await svc.kick('ch-001')
    const after = (await svc.get('ch-001'))!
    expect(after.status.online).toBe(false)
    expect(after.status.viewerCount).toBe(0)
  })
})

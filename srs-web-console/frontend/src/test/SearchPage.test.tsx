import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SearchPage from '@/pages/Search'
import { MemoryRouter } from 'react-router-dom'
import type { SearchPageResult } from '@/api/searchService'
import { searchService } from '@/api/searchService'
import { formatRangeFull } from '@/utils/timeRange'
vi.mock('@/api/searchService', async original => ({ ...await original<typeof import('@/api/searchService')>(), searchService: { coverage: vi.fn(), status: vi.fn(), channels: vi.fn(), query: vi.fn(), page: vi.fn(), detail: vi.fn(), cancel: vi.fn(), feedback: vi.fn() } }))
const flags=vi.hoisted(()=>({aiReference:true}))
vi.mock('@/pages/Search/aiReference',()=>({aiReferenceEnabled:()=>flags.aiReference}))
vi.mock('@/components/common/AuthImage', () => ({ AuthImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} /> }))
beforeEach(() => {
  vi.resetAllMocks()
  flags.aiReference = true
  vi.mocked(searchService.coverage).mockImplementation(async scope => ({ scope, state: 'unknown', ranges: [] }))
  vi.mocked(searchService.cancel).mockResolvedValue({ cancelled: true })
  vi.mocked(searchService.feedback).mockResolvedValue({ relevant: true })
  vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'a', name: '后门' }, { id: 'b', name: '大门' }] })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('explains a large source selection before exceeding the100-channel contract and keeps checked sources removable', async () => {
  const cameras = Array.from({ length: 200 }, (_, index) => ({ id: `camera-${index}`,
    name: `${index < 100 ? '南区' : '北区'}摄像头${String(index % 100 + 1).padStart(3, '0')}` }))
  vi.mocked(searchService.channels).mockResolvedValue({ items: cameras })
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByLabelText('南区摄像头001')
  expect(screen.getByRole('button', { name: '选择当前列表' })).toBeDisabled()
  expect(screen.getByText(/全部选中当前列表后将达到 200/)).toBeInTheDocument()
  expect(screen.getByLabelText('南区摄像头001')).not.toBeChecked()
  fireEvent.change(screen.getByRole('textbox', { name: '查找摄像头' }), { target: { value: '南区' } })
  fireEvent.click(screen.getByRole('button', { name: '选择当前列表' }))
  expect(screen.getByText('摄像头 · 已选 100 / 100')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: '查找摄像头' }), { target: { value: '' } })
  expect(screen.getByLabelText('北区摄像头001')).toBeDisabled()
  expect(screen.getByLabelText('南区摄像头001')).toBeEnabled()
  fireEvent.click(screen.getByLabelText('南区摄像头001'))
  expect(screen.getByLabelText('北区摄像头001')).toBeEnabled()
  fireEvent.click(screen.getByLabelText('北区摄像头001'))
  expect(screen.getByLabelText('北区摄像头001')).toBeChecked()
  expect(screen.getByLabelText('南区摄像头001')).not.toBeChecked()
  expect(screen.getByText('摄像头 · 已选 100 / 100')).toBeInTheDocument()
})
it('shows real unavailable state rather than no matches, with searchable channel selection', async () => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeDisabled()
  expect(screen.getByText(/当前无法完成所选范围的搜索/)).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: '查找摄像头' }), { target: { value: '后' } })
  fireEvent.click(screen.getByRole('button', { name: '选择当前列表' }))
  expect(screen.getByRole('checkbox', { name: '后门' })).toBeChecked()
  expect(screen.queryByRole('checkbox', { name: '大门' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '清除选择' }))
  expect(screen.getByRole('checkbox', { name: '后门' })).not.toBeChecked()
})
it.each([
  ['disabled', '智能搜索未启用', '智能搜索尚未启用'],
  ['config_pending', '配置等待应用', '搜索配置正在等待服务应用'],
] as const)('explains %s without reporting an empty result', async (reason, title, explanation) => {
  vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason, model_version: null })
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
  expect(screen.getByText(new RegExp(explanation))).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeDisabled()
})
it('retry preserves the description and handles connection failure explicitly', async () => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '黑色背包' } })
  vi.mocked(searchService.status).mockRejectedValueOnce(new Error('连接超时'))
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连接超时'))
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('黑色背包')
})
function result(id: string, name = '后门'): SearchPageResult {
  return { search_id: id, scope: { channel_ids: ['a'], from: '2026-10-27T01:00:00Z', to: '2026-10-28T01:00:00Z' },
    model_version: 'test', coverage: 'partial', next_cursor: null, items: [{
      id: 'result-a', channel_id: 'a', channel_name: name, source_input_id: 'input-a', processor_id: 'ai-a', output_channel_id: 'output-a',
      kind: 'object', started_at: '2026-10-27T01:00:00Z', ended_at: '2026-10-27T01:00:03Z',
      frames: [{ id: 'frame-a', captured_at: '2026-10-27T01:00:01Z', role: 'match' }, { id: 'frame-b', captured_at: '2026-10-27T01:00:02Z', role: 'after' }],
      recording: { channel_id: 'output-a', state: 'available' }, verification: { state: 'candidate' }, feedback: null,
    }] }
}
async function ready() {
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'test' })
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('checkbox', { name: '后门' }))
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '黑色背包' } })
}
it('submits a UUID request on HTTP LAN browsers without crypto.randomUUID', async () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index))
    return bytes
  })
  vi.stubGlobal('crypto', { getRandomValues })
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  expect(searchService.query).toHaveBeenCalledWith(expect.objectContaining({
    request_id: '00010203-0405-4607-8809-0a0b0c0d0e0f',
  }), expect.any(AbortSignal))
  expect(getRandomValues).toHaveBeenCalledTimes(1)
})
it('keeps the previous search and input when secure request ID creation fails', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  const card = await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  fireEvent.click(card)
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '新的描述' } })
  vi.stubGlobal('crypto', undefined)
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('当前浏览器无法生成安全请求标识')
  expect(searchService.query).toHaveBeenCalledTimes(1)
  expect(searchService.cancel).not.toHaveBeenCalled()
  expect(card).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('complementary', { name: '候选详情' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('新的描述')
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeEnabled()
  expect(screen.getByText(/本次描述/)).toHaveTextContent('黑色背包')
})
it('search results keep evidence and playback on the explicit recording output', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  expect(screen.getByText(/本次描述/)).toHaveTextContent(formatRangeFull(new Date(Date.parse('2026-10-28T01:00:00Z') - 1)))
  const href = screen.getByRole('link', { name: '播放前后录像' }).getAttribute('href')!
  expect(screen.getByRole('link', { name: '播放前后录像' })).toHaveAttribute('target', '_blank')
  expect(href).toContain('/playback/output-a?from=')
  expect(href).toContain(`from=${Date.parse('2026-10-27T01:00:00Z') - 2000}`)
  expect(href).toContain(`to=${Date.parse('2026-10-27T01:00:03Z') + 15000}`)
  expect(screen.getByText(/AI 参考仅针对命中帧/)).toBeInTheDocument()
  expect(screen.getByText(/所选范围有未分析或缺失时段/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '相关' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'true'))
  expect(searchService.feedback).toHaveBeenCalledWith(expect.any(String), 'result-a', true)
  fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(screen.queryByRole('complementary', { name: '候选详情' })).not.toBeInTheDocument()
})
it('cancels an old request and ignores its late results after a new query', async () => {
  let finish!: (value: SearchPageResult) => void
  vi.mocked(searchService.query).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(async input => result(input.request_id, '新查询结果'))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '取消搜索' }))
  expect(searchService.cancel).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：新查询结果' })
  finish(result('old-id', '旧查询结果'))
  await waitFor(() => expect(screen.queryByRole('button', { name: /旧查询结果/ })).not.toBeInTheDocument())
})
it('unavailable recordings keep their images without an incorrect playback fallback', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items[0]!.recording = { channel_id: null, state: 'missing' }
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  expect(screen.getByText(/仍可查看保存的证据图片/)).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '播放前后录像' })).not.toBeInTheDocument()
})
it('refreshes a later page and pending recording without moving the open evidence or resetting pagination', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => { const page = result(input.request_id); page.items[0]!.verification = { state: 'uncertain' }; return { ...page, next_cursor: 'v1.20' } })
  let laterCalls = 0
  vi.mocked(searchService.page).mockImplementation(async (id, cursor) => {
    expect(cursor).toBe('v1.20')
    const page = result(id, '后续候选')
    page.coverage = 'sampled'
    page.items[0]!.id = 'result-later'
    page.items[0]!.recording = { channel_id: 'output-a', state: ++laterCalls === 1 ? 'pending' : 'available' }
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更多' })) })
  fireEvent.click(screen.getByRole('button', { name: '查看第 2 条候选：后续候选' }))
  const panel = screen.getByRole('complementary', { name: '候选详情' })
  expect(panel).toHaveFocus()
  expect(within(panel).getByText(/录像状态待确认/)).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(searchService.page).toHaveBeenCalledTimes(2)
  expect(within(panel).getByRole('link', { name: '播放前后录像' })).toBeInTheDocument()
  expect(panel).toHaveFocus()
  expect(screen.getByRole('button', { name: '查看第 1 条候选：后门' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看第 2 条候选：后续候选' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/所选范围有未分析或缺失时段/)).toBeInTheDocument()
})
it('refreshes verification for loaded later pages rather than only polling the first page', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => { const page = result(input.request_id); page.items[0]!.verification = { state: 'uncertain' }; return { ...page, next_cursor: 'v1.20' } })
  let calls = 0
  vi.mocked(searchService.page).mockImplementation(async (id, cursor) => {
    expect(cursor).toBe('v1.20')
    const page = result(id, '等待复核的第二页')
    page.items[0]!.id = 'result-later'
    page.items[0]!.verification = { state: ++calls === 1 ? 'queued' : 'match' }
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更多' })) })
  fireEvent.click(screen.getByRole('button', { name: '查看第 2 条候选：等待复核的第二页' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(within(screen.getByRole('complementary', { name: '候选详情' })).getByText('AI 参考：符合描述')).toBeInTheDocument()
  expect(searchService.page).toHaveBeenCalledTimes(2)
})
it('ignores a late pagination response after starting another query', async () => {
  let oldId = '', finish!: (value: SearchPageResult) => void
  vi.mocked(searchService.query).mockImplementationOnce(async input => {
    oldId = input.request_id
    return { ...result(input.request_id), next_cursor: 'v1.20' }
  }).mockImplementationOnce(async input => result(input.request_id, '新查询'))
  vi.mocked(searchService.page).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：新查询' })
  await act(async () => { finish(result(oldId, '旧查询的后续页')) })
  expect(screen.queryByRole('button', { name: /旧查询的后续页/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看第 1 条候选：新查询' })).toBeInTheDocument()
})
it('does not infer missing recordings from expired evidence or keep polling absent candidates', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items[0]!.verification = { state: 'running' }
    page.items.push({ ...page.items[0]!, id: 'result-second', channel_name: '录像待确认的候选', recording: { channel_id: 'output-a', state: 'pending' } })
    return page
  })
  vi.mocked(searchService.page).mockImplementation(async id => ({ ...result(id), items: [] }))
  await ready()
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '搜索录像' })) })
  fireEvent.click(screen.getByRole('button', { name: '查看第 1 条候选：后门' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByText(/部分候选证据已过期或不可访问/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '播放前后录像' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '查看第 2 条候选：录像待确认的候选' }))
  expect(within(screen.getByRole('complementary')).getByText(/录像状态待确认/)).toBeInTheDocument()
  expect(screen.queryByText(/对应录像不可用/)).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
  expect(searchService.page).toHaveBeenCalledTimes(1)
})
it('keeps feedback errors attached to their original candidate after selection changes', async () => {
  let fail!: (error: Error) => void
  vi.mocked(searchService.feedback).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items.push({ ...page.items[0]!, id: 'result-second', channel_name: '另一条候选' })
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  fireEvent.click(screen.getByRole('button', { name: '相关' }))
  fireEvent.click(screen.getByRole('button', { name: '查看第 2 条候选：另一条候选' }))
  await act(async () => { fail(new Error('连接超时')) })
  const panel = screen.getByRole('complementary', { name: '候选详情' })
  expect(within(panel).queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('第 1 条候选的反馈未保存')
  expect(within(panel).getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(screen.getByRole('button', { name: '返回该候选重试' }))
  expect(within(panel).getByRole('alert')).toHaveTextContent('反馈未保存：连接超时')
})
it('supports adjacent candidates and restores the selected card focus on Escape or close', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items.push({ ...page.items[0]!, id: 'result-second', channel_name: '另一条候选' })
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  const first = await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
  fireEvent.click(first)
  const panel = screen.getByRole('complementary', { name: '候选详情' })
  fireEvent.keyDown(screen.getByRole('textbox', { name: '想找什么？' }), { key: 'ArrowRight' })
  expect(first).toHaveAttribute('aria-pressed', 'true')
  fireEvent.keyDown(panel, { key: 'ArrowRight' })
  const second = screen.getByRole('button', { name: '查看第 2 条候选：另一条候选' })
  expect(second).toHaveAttribute('aria-pressed', 'true')
  expect(panel).toHaveFocus()
  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  expect(second).toHaveFocus()
  fireEvent.click(first)
  fireEvent.click(screen.getByRole('button', { name: '关闭详情' }))
  expect(first).toHaveFocus()
})
it('does not carry an old query feedback response into a new query containing the same candidate', async () => {
  let finish!: (value: { relevant: boolean }) => void
  vi.mocked(searchService.feedback).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  fireEvent.click(screen.getByRole('button', { name: '相关' }))
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  await act(async () => { finish({ relevant: true }) })
  expect(screen.getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'false')
})
it('does not describe the whole range as empty when the current page is empty but more slots remain', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => ({ ...result(input.request_id), items: [], next_cursor: 'v1.20' }))
  vi.mocked(searchService.page).mockImplementation(async id => result(id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByText('本批候选证据已过期或不可用')
  expect(screen.queryByText('所选范围内暂未找到相关候选')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  await screen.findByRole('button', { name: '查看第 1 条候选：后门' })
})
it('distinguishes an unavailable service from model setup and never turns a failed query into no matches', async () => {
  vi.mocked(searchService.status).mockResolvedValueOnce({ ready: false, reason: 'service_unavailable', model_version: null })
  const { unmount } = render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByText('搜索服务暂不可用，请检查服务运行状态后重新尝试。')
  expect(screen.queryByText('所选范围内暂未找到相关候选')).not.toBeInTheDocument()
  unmount()
  vi.mocked(searchService.query).mockRejectedValueOnce(new Error('模型尚未就绪'))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('模型尚未就绪')
  expect(screen.queryByText('所选范围内暂未找到相关候选')).not.toBeInTheDocument()
  expect(searchService.cancel).toHaveBeenCalled()
})
it.each([
  ['query_too_long', '搜索描述过长，请保留关键特征后重试'],
  ['query_unrepresentable', '当前模型无法编码这段描述，请使用普通文字改写后重试'],
] as const)('keeps %s actionable on the description without showing an empty result', async (code, message) => {
  vi.mocked(searchService.query).mockRejectedValueOnce(Object.assign(new Error(message), { code }))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  const alert = await screen.findByRole('alert')
  const input = screen.getByRole('textbox', { name: '想找什么？' })
  expect(alert).toHaveTextContent(message)
  expect(input).toHaveFocus()
  expect(input).toHaveValue('黑色背包')
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(input).toHaveAttribute('aria-describedby', expect.stringContaining(alert.id))
  expect(screen.queryByText('所选范围内暂未找到相关候选')).not.toBeInTheDocument()
  fireEvent.change(input, { target: { value: '背包' } })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(input).not.toHaveAttribute('aria-invalid')
  expect(screen.getByRole('checkbox', { name: '后门' })).toBeChecked()
})
it('Escape cancels a pending search without erasing the input or accepting its late response', async () => {
  let finish!: (value: SearchPageResult) => void
  vi.mocked(searchService.query).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.keyDown(screen.getByRole('textbox', { name: '想找什么？' }), { key: 'Escape', isComposing: true })
  expect(searchService.cancel).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('textbox', { name: '想找什么？' }), { key: 'Escape' })
  expect(searchService.cancel).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('黑色背包')
  await act(async () => { finish(result('cancelled', '已取消结果')) })
  expect(screen.queryByRole('button', { name: /已取消结果/ })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '搜索录像' })).not.toBeDisabled()
})
it('distinguishes loading, unavailable storage, and missing AI outputs with an existing configuration link', async () => {
  let finish!: (value: Awaited<ReturnType<typeof searchService.status>>) => void
  vi.mocked(searchService.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  vi.mocked(searchService.channels).mockResolvedValueOnce({ items: [] })
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  expect(screen.getByRole('heading', { name: '正在检查搜索服务' })).toBeInTheDocument()
  await act(async () => { finish({ ready: false, reason: 'storage_unavailable', model_version: null }) })
  expect(screen.getByRole('heading', { name: '搜索存储不可用' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '前往搜索配置' })).toHaveAttribute('href', '/config-center?category=search-service')
  expect(screen.getByText('暂无可搜索的 AI 输出通道，请先配置 AI 通道。')).toBeInTheDocument()
})
it('describes scene evidence as a saved screenshot without implying an unavailable location marker', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items[0]!.kind = 'scene'
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  expect(within(screen.getByRole('complementary')).getByText(/匹配画面区域：整幅场景截图，未定位精确目标/)).toBeInTheDocument()
  expect(screen.queryByText(/标示的是匹配画面区域/)).not.toBeInTheDocument()
  expect(screen.queryByText(/画面区域命中/)).not.toBeInTheDocument()
})

it('labels unsupported live panorama sampling but keeps historical channel selection and search usable', async () => {
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'test' });
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'a', name: '全景后门', sampling_supported: false, sampling_reason: 'projection_unsupported' }] });
  vi.mocked(searchService.query).mockImplementation(async input => ({ ...result(input.request_id), scope: input.scope }));
  render(<MemoryRouter><SearchPage /></MemoryRouter>);
  const history = await screen.findByRole('checkbox', { name: /全景后门/ });
  expect(history).not.toBeDisabled();
  expect(screen.getByText('全景采集待验证 · 可查历史')).toBeInTheDocument();
  fireEvent.click(history);
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '黑色背包' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  await waitFor(() => expect(searchService.query).toHaveBeenCalledTimes(1));
  expect(vi.mocked(searchService.query).mock.calls[0]![0].scope.channel_ids).toEqual(['a']);
});

it('polls initial head candidates, preserves feedback and selection, then stops on final reference state', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items = Array.from({ length: 6 }, (_, n) => ({ ...page.items[0]!, id: `candidate-${n}`, channel_name: `摄像头${n}` }))
    return page
  })
  vi.mocked(searchService.page).mockImplementation(async id => {
    const page = result(id)
    page.items = Array.from({ length: 6 }, (_, n) => ({ ...page.items[0]!, id: `candidate-${n}`, channel_name: `摄像头${n}`,
      verification: n < 5 ? { state: 'mismatch' as const, validated: false as const, cached: true, reason: 'visible_evidence' } : { state: 'candidate' as const } }))
    return page
  })
  await ready()
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '搜索录像' })) })
  fireEvent.click(screen.getByRole('button', { name: '查看第 1 条候选：摄像头0' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '相关' })) })
  expect(screen.getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'true')
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  const panel = screen.getByRole('complementary')
  expect(within(panel).getByText('AI 参考：不符合描述')).toBeInTheDocument()
  expect(within(panel).getByText(/沿用相同查询与证据/)).toBeInTheDocument()
  expect(within(panel).getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '查看第 6 条候选：摄像头5' })).toHaveTextContent('候选，尚未复核')
  expect(screen.getByRole('button', { name: '查看第 1 条候选：摄像头0' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/参考分析未标定，不是概率/)).toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
  expect(searchService.page).toHaveBeenCalledTimes(1)
})
it('explains disabled verification and does not keep polling or hide its candidate', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items[0]!.verification = { state: 'unavailable', validated: false, reason: 'task_unavailable' }
    return page
  })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  expect(screen.getByText(/搜索参考分析未启用或暂不可用/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '相关' })).toBeEnabled()
  vi.useFakeTimers()
  await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
  expect(searchService.page).not.toHaveBeenCalled()
})
it.each([403, 410])('stops reading and feedback after permanent search failure %s without dropping candidates', async status => {
  vi.mocked(searchService.query).mockImplementation(async input => {
    const page = result(input.request_id)
    page.items[0]!.verification = { state: 'queued', validated: false }
    page.items.push({ ...page.items[0]!, id: 'finished-reference', channel_name: '已完成参考', verification: { state: 'match', validated: false } })
    return { ...page, next_cursor: 'v1.next' }
  })
  vi.mocked(searchService.page).mockRejectedValue(Object.assign(new Error('unavailable'), { status }))
  await ready()
  vi.useFakeTimers()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '搜索录像' })) })
  fireEvent.click(screen.getByRole('button', { name: '查看第 1 条候选：后门' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.getByText(status === 403 ? /搜索证据访问权限已变化/ : /本次搜索或证据已过期/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看第 1 条候选：后门' })).toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看第 1 条候选：后门' })).toHaveTextContent('AI 参考：分析已停止')
  expect(within(screen.getByRole('complementary')).getByText('AI 参考：分析已停止')).toBeInTheDocument()
  expect(screen.queryByText('AI 参考：等待分析')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看第 2 条候选：已完成参考' })).toHaveTextContent('AI 参考：符合描述')

  expect(screen.getByRole('button', { name: '相关' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '不相关' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '加载更多' })).toBeDisabled()
  await act(async () => { await vi.advanceTimersByTimeAsync(12000) })
  expect(searchService.page).toHaveBeenCalledTimes(1)
  expect(searchService.cancel).toHaveBeenCalledTimes(1)
})
it('stops feedback on a permanent denial without changing the saved human opinion', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  vi.mocked(searchService.feedback).mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  fireEvent.click(screen.getByRole('button', { name: '相关' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '相关' })).toBeDisabled())
  expect(screen.getByRole('button', { name: '相关' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByText(/搜索证据访问权限已变化/)).toBeInTheDocument()
})

it('treats a failed camera catalog as unreadable rather than encouraging duplicate setup', async () => {
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'test' })
  vi.mocked(searchService.channels).mockRejectedValue(new Error('摄像头目录连接失败'))
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  expect(await screen.findByText('暂时无法读取摄像头列表，请恢复服务后重新检查。')).toBeInTheDocument()
  expect(screen.queryByText('暂无可搜索的 AI 输出通道，请先配置 AI 通道。')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '选择当前列表' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: '查找摄像头' })).toBeDisabled()
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toBeEnabled()
  const reason = screen.getByRole('alert'), action = screen.getByRole('button', { name: '搜索录像' })
  expect(reason.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(action).toBeDisabled()
})
it('places the unavailable reason before search conditions while allowing condition editing', async () => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  const reason = screen.getByRole('heading', { name: '等待搜索能力就绪' }).closest('section')!
  const conditions = screen.getByRole('form', { name: '搜索条件' })
  expect(reason.compareDocumentPosition(conditions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '先编辑描述' } })
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('先编辑描述')
  fireEvent.click(screen.getByRole('checkbox', { name: '后门' }))
  expect(screen.getByRole('checkbox', { name: '后门' })).toBeChecked()
})


it('inherits an explicit evidence output scope and clears it without losing the description', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id, name: '入口输出' }] });
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'test' });
  vi.mocked(searchService.query).mockResolvedValue(result('inherited'));
  render(<MemoryRouter initialEntries={[`/smart-search?channel=${id}&from=1793062800000&to=1793062860000`]}><SearchPage /></MemoryRouter>);
  expect(await screen.findByRole('checkbox', { name: '入口输出' })).toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '红衣' } });
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  await screen.findByRole('button', { name: /查看第 1 条候选/ });
  await waitFor(() => expect(searchService.coverage).toHaveBeenCalled());
  expect(vi.mocked(searchService.query).mock.calls[0]![0].scope).toEqual({ channel_ids: [id], from: new Date(1793062800000).toISOString(), to: new Date(1793062860000).toISOString() });
  fireEvent.click(screen.getByRole('button', { name: '清除继承范围' }));
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('红衣');
  fireEvent.click(screen.getByRole('button', { name: '调整范围' }));
  expect(screen.getByRole('checkbox', { name: '入口输出' })).not.toBeChecked();
});
it('keeps returned candidates when coverage is unavailable and shows separate object and scene intervals on retry', async () => {
  vi.mocked(searchService.coverage).mockRejectedValueOnce(new Error('offline'));
  vi.mocked(searchService.query).mockResolvedValue(result('coverage'));
  await ready(); fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  expect(await screen.findByRole('button', { name: /查看第 1 条候选/ })).toBeInTheDocument();
  expect(await screen.findByText(/覆盖情况暂未确认；已返回的候选仍可核对/)).toBeInTheDocument();
  vi.mocked(searchService.coverage).mockImplementation(async scope => ({ scope, state: 'partial', ranges: [
    { channel_id: 'a', kind: 'object', from: scope.from, to: scope.to, state: 'sampled' },
    { channel_id: 'a', kind: 'scene', from: scope.from, to: scope.to, state: 'gap' },
  ] }));
  fireEvent.click(screen.getByRole('button', { name: '重新确认覆盖' }));
  expect(await screen.findByText('目标 · 1 个记录区间')).toBeInTheDocument();
  expect(screen.getByText('场景 · 1 个记录区间')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /查看第 1 条候选/ })).toBeInTheDocument();
});
it('stops access when the independent coverage request rejects authorization', async () => {
  vi.mocked(searchService.coverage).mockRejectedValue(Object.assign(new Error('denied'), { status: 403 }));
  vi.mocked(searchService.query).mockResolvedValue(result('coverage-denied'));
  await ready(); fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  expect(await screen.findByText(/搜索范围访问权限已变化/)).toBeInTheDocument();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
it('reorders only loaded candidates explicitly, preserves selection and appends later pages', async () => {
  const first = result('sorted'); first.next_cursor = 'v1.20';
  first.items[0]!.verification.state = 'mismatch';
  first.items.push({ ...structuredClone(first.items[0]!), id: 'result-b', verification: { state: 'match' } });
  const next = result('sorted'); next.items = [{ ...next.items[0]!, id: 'result-c', verification: { state: 'match' } }];
  vi.mocked(searchService.query).mockResolvedValue(first); vi.mocked(searchService.page).mockResolvedValue(next);
  await ready(); fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  fireEvent.click(await screen.findByRole('button', { name: /查看第 1 条候选/ }));
  expect(screen.getByRole('complementary')).toHaveTextContent('1 / 2');
  fireEvent.click(screen.getByRole('button', { name: '按复核状态重排已加载候选' }));
  expect(screen.getByRole('complementary')).toHaveTextContent('2 / 2');
  expect(screen.getByRole('button', { name: /查看第 2 条候选/ })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await waitFor(() => expect(screen.getByRole('complementary')).toHaveTextContent('2 / 3'));
  expect(screen.getByRole('button', { name: /查看第 2 条候选/ })).toHaveAttribute('aria-pressed', 'true');
  const strip = screen.getByLabelText('切换候选');
  fireEvent.touchStart(strip, { touches: [{ clientX: 200, clientY: 20 }] });
  fireEvent.touchEnd(strip, { touches: [], changedTouches: [{ clientX: 100, clientY: 25 }] });
  expect(screen.getByRole('complementary')).toHaveTextContent('3 / 3');
  fireEvent.touchStart(strip, { touches: [{ clientX: 100, clientY: 20 }, { clientX: 200, clientY: 20 }] });
  fireEvent.touchEnd(strip, { touches: [], changedTouches: [{ clientX: 250, clientY: 20 }] });
  expect(screen.getByRole('complementary')).toHaveTextContent('3 / 3');
});

it('pauses AI reference analysis so the model stays free for alarm review', async () => {
  flags.aiReference = false
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  expect(searchService.query).toHaveBeenCalledWith(expect.objectContaining({ verify: false }), expect.anything())
  expect(screen.queryByText(/AI 参考：/)).not.toBeInTheDocument()
  expect(screen.queryByText('候选，尚未复核')).not.toBeInTheDocument()
  expect(screen.queryByText(/AI 参考仅针对命中帧/)).not.toBeInTheDocument()
  expect(screen.getByText(/AI 参考分析已暂停/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /按复核状态重排/ })).not.toBeInTheDocument()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(searchService.page).not.toHaveBeenCalled()
})

it('keeps slider and numeric minimum in sync and submits a frozen search condition', async () => {
  await ready();
  const slider = screen.getByRole('slider', { name: '拖动最低相似度' });
  const numeric = screen.getByRole('spinbutton', { name: '最低相似度' });
  expect(numeric).toHaveValue(0.07);
  expect(slider).toHaveAttribute('max', '0.2');
  expect(slider).toHaveAttribute('step', '0.005');
  fireEvent.change(slider, { target: { value: '0.075' } });
  expect(numeric).toHaveValue(0.075);
  fireEvent.change(slider, { target: { value: '0.15' } });
  expect(numeric).toHaveValue(0.15);
  fireEvent.change(numeric, { target: { value: '0.2' } });
  expect(slider).toHaveValue('0.2');
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '白色衣服' } });
  vi.mocked(searchService.query).mockResolvedValue({ ...result('minimum-search'), min_similarity: 0.2, items: [] });
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  await screen.findByText('所选范围内，没有候选达到当前相似度要求');
  expect(vi.mocked(searchService.query).mock.calls[0]![0].min_similarity).toBe(0.2);
  fireEvent.click(screen.getByRole('button', { name: '不限' }));
  expect(numeric).toHaveValue(null);
  expect(screen.getByText(/本次最低相似度 0.20/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }));
  await waitFor(() => expect(searchService.query).toHaveBeenCalledTimes(2));
  expect(vi.mocked(searchService.query).mock.calls[1]![0].min_similarity).toBeUndefined();
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SearchPage from '@/pages/Search'
import { MemoryRouter } from 'react-router-dom'
import type { SearchPageResult } from '@/api/searchService'
import { searchService } from '@/api/searchService'
vi.mock('@/api/searchService', async original => ({ ...await original<typeof import('@/api/searchService')>(), searchService: { status: vi.fn(), channels: vi.fn(), query: vi.fn(), page: vi.fn(), detail: vi.fn(), cancel: vi.fn(), feedback: vi.fn() } }))
vi.mock('@/components/common/AuthImage', () => ({ AuthImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} /> }))
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(searchService.cancel).mockResolvedValue({ cancelled: true })
  vi.mocked(searchService.feedback).mockResolvedValue({ relevant: true })
  vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'a', name: '后门' }, { id: 'b', name: '大门' }] })
})
afterEach(() => { vi.useRealTimers() })
it('shows real unavailable state rather than no matches, with searchable channel selection', async () => {
  render(<SearchPage />)
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
  render(<SearchPage />)
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument()
  expect(screen.getByText(new RegExp(explanation))).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeDisabled()
})
it('retry preserves the description and handles connection failure explicitly', async () => {
  render(<SearchPage />)
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
it('search results keep evidence and playback on the explicit recording output', async () => {
  vi.mocked(searchService.query).mockImplementation(async input => result(input.request_id))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看第 1 条候选：后门' }))
  const href = screen.getByRole('link', { name: '播放前后录像' }).getAttribute('href')!
  expect(screen.getByRole('link', { name: '播放前后录像' })).toHaveAttribute('target', '_blank')
  expect(href).toContain('/playback/output-a?from=')
  expect(href).toContain(`from=${Date.parse('2026-10-27T01:00:00Z') - 2000}`)
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
  vi.mocked(searchService.query).mockImplementation(async input => ({ ...result(input.request_id), next_cursor: 'v1.20' }))
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
  vi.mocked(searchService.query).mockImplementation(async input => ({ ...result(input.request_id), next_cursor: 'v1.20' }))
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
  expect(within(screen.getByRole('complementary', { name: '候选详情' })).getByText('AI 复核符合')).toBeInTheDocument()
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

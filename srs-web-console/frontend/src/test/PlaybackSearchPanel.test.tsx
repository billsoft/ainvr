import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PlaybackPage from '@/pages/Playback'
import { recordingService } from '@/api/recordingService'
import { searchService, type SearchPageResult } from '@/api/searchService'
import type { RecordingSegment } from '@/types/recording'

vi.mock('@/api/recordingService', async (original) => {
  const actual = await original<typeof import('@/api/recordingService')>()
  return { ...actual, recordingService: actual.createMockRecordingService() }
})
vi.mock('@/api/searchService', async original => ({ ...await original<typeof import('@/api/searchService')>(), searchService: { coverage: vi.fn(), status: vi.fn(), channels: vi.fn(), query: vi.fn(), page: vi.fn(), detail: vi.fn(), cancel: vi.fn(), feedback: vi.fn() } }))
vi.mock('@/pages/Search/aiReference', () => ({ aiReferenceEnabled: () => false }))
vi.mock('@/components/common/AuthImage', () => ({ AuthImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} /> }))

let now = 0
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-10-24T12:00:00+08:00'))
  now = Date.now()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.mocked(searchService.coverage).mockImplementation(async scope => ({ scope, state: 'unknown', ranges: [] }))
  vi.mocked(searchService.cancel).mockResolvedValue({ cancelled: true })
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'test' })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'a', name: '后门' }] })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const hit = (): SearchPageResult => ({
  search_id: 's1', scope: { channel_ids: ['a'], from: new Date(now - 7200_000).toISOString(), to: new Date(now).toISOString() },
  model_version: 'test', coverage: 'sampled', next_cursor: null,
  items: [{
    id: 'r1', channel_id: 'a', channel_name: '后门', source_input_id: 'i', processor_id: 'p', output_channel_id: 'demo-detect-ai', kind: 'scene',
    started_at: new Date(now - 3_600_000).toISOString(), ended_at: new Date(now - 3_597_000).toISOString(),
    frames: [{ id: 'f1', captured_at: new Date(now - 3_599_000).toISOString(), role: 'match' }],
    recording: { channel_id: 'demo-detect-ai', state: 'available' }, verification: { state: 'candidate' }, feedback: null,
  }],
})
const seg = (id: string, channelId: string, startTs: number): RecordingSegment =>
  ({ id, channelId, startTs, endTs: startTs + 120_000, playable: true, sizeBytes: 1000, durationMs: 120_000 } as RecordingSegment)

function Where() { const l = useLocation(); return <><output data-testid="where">{l.pathname}</output><output data-testid="query">{l.search}</output></> }

it('opens the recorded source rather than the empty first channel on menu entry', async () => {
  vi.spyOn(recordingService, 'listChannels').mockResolvedValue([
    {id:'empty', name:'无录像', recording:false, kind:'source', sourceOnline:false, codec:null},
    {id:'available', name:'有录像', recording:true, kind:'source', sourceOnline:true, codec:'h264', oldestSegmentTs:now-60000},
  ])
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([seg('evidence','available',now-30000)])
  render(<RouterProvider router={createMemoryRouter([{path:'/playback/:channelId?',element:<><PlaybackPage/><Where/></>}],{initialEntries:['/playback']})}/>)
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/playback/available'))
})
it('offers a multiline description and names the selected camera before searching', async () => {
  open('/playback/demo-detect?search=1')
  expect((await screen.findByRole('textbox',{name:'想找什么？'})).tagName).toBe('TEXTAREA')
  await screen.findByText(/后门.*1 路/)
  fireEvent.click(screen.getByRole('button',{name:'选择搜索范围'}))
  const tick = within(screen.getByRole('region',{name:'可搜索通道'})).getByRole('checkbox',{name:'后门'})
  fireEvent.click(tick)
  expect(screen.getByRole('button',{name:'搜索录像'})).toBeDisabled()
  fireEvent.click(tick)
  fireEvent.change(screen.getByRole('textbox',{name:'想找什么？'}), {target:{value:'蓝色工作服'}})
  vi.mocked(searchService.query).mockResolvedValue(hit())
  fireEvent.click(screen.getByRole('button',{name:'搜索录像'}))
  await waitFor(() => expect(vi.mocked(searchService.query).mock.lastCall?.[0].scope.channel_ids).toEqual(['a']))
})
function open(entry: string) {
  const router = createMemoryRouter([{ path: '/playback/:channelId', element: <><PlaybackPage /><Where /></> }], { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
}

it('shows the search panel beside the player and plays a result on its own recording without leaving the page', async () => {
  vi.spyOn(recordingService, 'listSegments').mockImplementation(async (channel) =>
    [seg(`seg-${channel}`, channel, now - 3_650_000)])
  vi.mocked(searchService.query).mockResolvedValue(hit())
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open('/playback/demo-detect?search=1')
  const panel = await screen.findByLabelText('智能搜索')
  expect(panel).toBeInTheDocument()
  await waitFor(() => expect(prepare).toHaveBeenCalledWith('seg-demo-detect', expect.anything()))
  fireEvent.change(await screen.findByRole('textbox', { name: '想找什么？' }), { target: { value: '背包' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: /查看第 1 条候选/ }))
  // The result's recording belongs to another channel: the page follows it and plays there.
  await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/playback/demo-detect-ai'))
  await waitFor(() => expect(prepare).toHaveBeenCalledWith('seg-demo-detect-ai', expect.anything()))
  // The link has been followed: its one-shot parameters are gone, so a later window change starts normally.
  await waitFor(() => expect(screen.getByTestId('query')).not.toHaveTextContent('autoplay'))
  expect(screen.getByTestId('query')).not.toHaveTextContent('at=')
  // The search state survives: the results are still listed.
  expect(screen.getByRole('button', { name: /查看第 1 条候选/ })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('背包')
  expect(screen.queryByRole('link', { name: /智能搜索/ })).toBeNull()
  // Clicking the result is the way to play it: there is no separate play button next to the picture.
  expect(screen.queryByRole('button', { name: /播放前后录像/ })).toBeNull()
  expect(screen.queryByRole('link', { name: /播放前后录像/ })).toBeNull()
  expect(screen.getByText(/找出其它相似的出现时刻/)).toBeInTheDocument()
})

it('seeks in place when the result is on the channel already open', async () => {
  vi.spyOn(recordingService, 'listSegments').mockImplementation(async (channel) =>
    [seg(`seg-${channel}`, channel, now - 3_650_000), seg(`late-${channel}`, channel, now - 1_000_000)])
  const result = hit()
  result.items[0]!.recording.channel_id = 'demo-detect'
  vi.mocked(searchService.query).mockResolvedValue(result)
  const prepare = vi.spyOn(recordingService, 'preparePlayback').mockResolvedValue(undefined)
  open('/playback/demo-detect?search=1')
  await waitFor(() => expect(prepare).toHaveBeenCalledWith('seg-demo-detect', expect.anything()))
  fireEvent.change(await screen.findByRole('textbox', { name: '想找什么？' }), { target: { value: '背包' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  prepare.mockClear()
  fireEvent.click(await screen.findByRole('button', { name: /查看第 1 条候选/ }))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByTestId('where')).toHaveTextContent('/playback/demo-detect')
  expect(screen.getByTestId('where')).not.toHaveTextContent('demo-detect-ai')
  expect(await screen.findAllByTestId('timeline-hit-mark')).toHaveLength(1)
})

it('keeps the search column closed until asked, from a slim rail, and has no separate smart-search page link', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect')
  const rail = await screen.findByRole('button', { name: '智能搜索' })
  expect(rail).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByLabelText('搜索条件')).toBeNull()
  fireEvent.click(rail)
  expect(await screen.findByLabelText('搜索条件')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '智能搜索' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '收起智能搜索' }))
  expect(await screen.findByRole('button', { name: '智能搜索' })).toBeInTheDocument()
})

it('takes the channels to search from ticks in the left list, with no second list in the panel', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'demo-detect-ai', name: '大门口_AI输出' }] })
  open('/playback/demo-detect?search=1')
  const tick = await screen.findByRole('checkbox', { name: '搜索范围：大门口_AI输出' })
  await waitFor(() => expect(tick).toBeChecked())
  // Only the searchable channel has a tick; the panel itself offers no channel picker.
  expect(screen.queryByRole('checkbox', { name: '搜索范围：大门口' })).toBeNull()
  expect(screen.queryByRole('checkbox', { name: '大门口_AI输出' })).toBeNull()
  expect(screen.getByText(/大门口_AI输出 等 1 路/)).toBeInTheDocument()
  fireEvent.click(tick)
  expect(tick).not.toBeChecked()
  expect(screen.getByText(/先选择要搜索的通道/)).toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('group', { name: '搜索范围' })).getByRole('button', { name: '全部 AI' }))
  expect(tick).toBeChecked()
})

it('folds the column that does not fit instead of floating it over the player; each toggle acts in one click', async () => {
  // Several components watch their size; every observer is told, the page's column logic among them.
  const observers: ((e: { contentRect: { width: number } }[]) => void)[] = []
  const resize = (width: number) => observers.forEach(cb => cb([{ contentRect: { width } }]))
  vi.stubGlobal('ResizeObserver', class { constructor(cb: (e: { contentRect: { width: number } }[]) => void) { observers.push(cb) } observe() {} disconnect() {} })
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1')
  const left = () => document.querySelector('aside[aria-label="通道列表"]')!
  const right = () => document.querySelector('aside[aria-label="智能搜索"]')!
  await screen.findByLabelText('搜索条件')
  act(() => resize(1700))
  expect(left()).not.toHaveAttribute('hidden'); expect(right()).not.toHaveAttribute('hidden')
  // Too narrow for both: the search that the address asked for stays, the channel list folds.
  act(() => resize(900))
  expect(left()).toHaveAttribute('hidden'); expect(right()).not.toHaveAttribute('hidden')
  // One click on the folded list shows it (and folds the search); one click on search brings it back.
  fireEvent.click(screen.getByRole('button', { name: '通道列表' }))
  expect(left()).not.toHaveAttribute('hidden'); expect(right()).toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: '智能搜索' }))
  expect(left()).toHaveAttribute('hidden'); expect(right()).not.toHaveAttribute('hidden')
  vi.unstubAllGlobals()
})

it('never offers a second channel picker: with the list folded away it offers to show the list again', async () => {
  const observers: ((e: { contentRect: { width: number } }[]) => void)[] = []
  const resize = (width: number) => observers.forEach(cb => cb([{ contentRect: { width } }]))
  vi.stubGlobal('ResizeObserver', class { constructor(cb: (e: { contentRect: { width: number } }[]) => void) { observers.push(cb) } observe() {} disconnect() {} })
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'demo-detect-ai', name: '大门口_AI输出' }] })
  open('/playback/demo-detect?search=1')
  await screen.findByLabelText('搜索条件')
  act(() => resize(1700))
  await screen.findByRole('checkbox', { name: '搜索范围：大门口_AI输出' })
  expect(screen.queryByRole('button', { name: '显示通道列表' })).toBeNull()
  act(() => resize(900))
  // The scope is only ever ticked in the channel list: no drop-down picker inside the panel.
  expect(screen.queryByRole('checkbox', { name: '大门口_AI输出' })).toBeNull()
  expect(screen.getByLabelText('搜索条件').querySelector('details')).not.toHaveAttribute('open')
  expect(screen.getByText(/大门口_AI输出 等 1 路/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '显示通道列表' }))
  expect(document.querySelector('aside[aria-label="通道列表"]')).not.toHaveAttribute('hidden')
  vi.unstubAllGlobals()
})

it('remembers which columns were open, and seeds the search scope from the channel open when it first appears', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'parking', name: '停车场AI' }, { id: 'demo-detect-ai', name: '大门口_AI输出' }] })
  open('/playback/parking')
  fireEvent.click(await screen.findByRole('button', { name: '智能搜索' }))
  // Opened while parking is the open channel: that channel (not the page's first one) is the scope.
  expect(await screen.findByRole('checkbox', { name: '搜索范围：停车场' })).toBeChecked()
  expect(JSON.parse(localStorage.getItem('playback.columns') ?? '{}')).toMatchObject({ right: true })
})

it('starts the side search at the last 24 hours and widens the panel for browsing, remembered per browser', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1&from=' + (now - 3_600_000) + '&to=' + now)
  await screen.findByRole('textbox', { name: '想找什么？' })
  // Only the channel is carried over from the player, never its time window.
  const presets = screen.getByRole('group', { name: '快捷时间范围' })
  expect(within(presets).getByRole('button', { name: '近24小时' })).toHaveAttribute('aria-pressed', 'true')
  const panel = screen.getByRole('complementary', { name: '智能搜索' })
  expect(panel.className).toContain('w-80')
  fireEvent.click(screen.getByRole('button', { name: '放大搜索面板' }))
  expect(screen.getByRole('button', { name: '还原搜索面板' })).toHaveAttribute('aria-pressed', 'true')
  expect(panel.className).toContain('flex-[1.2_1_0%]')
  expect(localStorage.getItem('playback.searchWide')).toBe('1')
  fireEvent.click(screen.getByRole('button', { name: '还原搜索面板' }))
  expect(panel.className).toContain('w-80')
  expect(localStorage.getItem('playback.searchWide')).toBe('0')
})

it('widening folds the channel list into its rail and restoring brings it back', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1')
  await screen.findByRole('textbox', { name: '想找什么？' })
  const left = () => document.querySelector('aside[aria-label="通道列表"]')!
  expect(left()).not.toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: '放大搜索面板' }))
  expect(left()).toHaveAttribute('hidden')
  // The scope is still reachable from the panel while wide.
  expect(screen.getByRole('button', { name: '显示通道列表' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '还原搜索面板' }))
  expect(left()).not.toHaveAttribute('hidden')
})

it('keeps the result head to one line and offers a search without the minimum when nothing reaches it', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  vi.mocked(searchService.query).mockClear()
  vi.mocked(searchService.query).mockImplementation(async input => ({ ...hit(), search_id: input.request_id, items: [], scope: input.scope,
    ...(input.min_similarity === undefined ? {} : { min_similarity: input.min_similarity }) }))
  vi.mocked(searchService.coverage).mockImplementation(async scope => ({ scope, state: 'partial', ranges: [] }))
  open('/playback/demo-detect?search=1')
  fireEvent.change(await screen.findByRole('textbox', { name: '想找什么？' }), { target: { value: '粉色围巾' } })
  const coverageBefore = vi.mocked(searchService.coverage).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  expect(await screen.findByText('没有达到 0.08 的候选')).toBeInTheDocument()
  await waitFor(() => expect(vi.mocked(searchService.coverage).mock.calls.length).toBeGreaterThan(coverageBefore))
  expect(screen.getByRole('heading', { name: '0 条候选' })).toBeInTheDocument()
  // No repeated description line and no separate coverage bar: both live behind the ⓘ toggle.
  expect(screen.queryByText(/本次描述/)).toBeNull()
  expect(await screen.findByText('采样覆盖')).not.toBeVisible()
  const info = screen.getByRole('button', { name: '结果说明' })
  fireEvent.click(info)
  expect(info).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('采样覆盖')).toBeVisible()
  expect(screen.getByText(/本次最低相似度 0.08/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '不限重搜' }))
  await waitFor(() => expect(searchService.query).toHaveBeenCalledTimes(2))
  expect(vi.mocked(searchService.query).mock.calls[1]![0].min_similarity).toBeUndefined()
  expect(vi.mocked(searchService.query).mock.calls[1]![0].query).toBe('粉色围巾')
  expect(screen.getByRole('spinbutton', { name: '最低相似度' })).toHaveValue(null)
}, 15000)

it('restores the channel list the widening folded even after a reload', async () => {
  localStorage.setItem('playback.searchWide', '1')
  localStorage.setItem('playback.searchWideFolded', '1')
  localStorage.setItem('playback.columns', JSON.stringify({ left: false, right: true }))
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1')
  await screen.findByRole('textbox', { name: '想找什么？' })
  const left = () => document.querySelector('aside[aria-label="通道列表"]')!
  expect(left()).toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: '还原搜索面板' }))
  expect(left()).not.toHaveAttribute('hidden')
  expect(localStorage.getItem('playback.searchWideFolded')).toBeNull()
})

it('keeps a channel list the person folded by hand folded when the panel is restored', async () => {
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1')
  await screen.findByRole('textbox', { name: '想找什么？' })
  const left = () => document.querySelector('aside[aria-label="通道列表"]')!
  fireEvent.click(screen.getByRole('button', { name: '放大搜索面板' }))
  expect(left()).toHaveAttribute('hidden')
  // Opened and folded again by hand while wide: the list is the person's choice now.
  fireEvent.click(screen.getByRole('button', { name: '显示通道列表' }))
  expect(left()).not.toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: '收起通道列表' }))
  expect(left()).toHaveAttribute('hidden')
  fireEvent.click(screen.getByRole('button', { name: '还原搜索面板' }))
  expect(left()).toHaveAttribute('hidden')
})

it('restoring on a page too narrow for three columns keeps the search panel and leaves the list folded', async () => {
  const observers: ((e: { contentRect: { width: number } }[]) => void)[] = []
  const resize = (width: number) => observers.forEach(cb => cb([{ contentRect: { width } }]))
  vi.stubGlobal('ResizeObserver', class { constructor(cb: (e: { contentRect: { width: number } }[]) => void) { observers.push(cb) } observe() {} disconnect() {} })
  vi.spyOn(recordingService, 'listSegments').mockResolvedValue([])
  open('/playback/demo-detect?search=1')
  await screen.findByRole('textbox', { name: '想找什么？' })
  const left = () => document.querySelector('aside[aria-label="通道列表"]')!
  const right = () => document.querySelector('aside[aria-label="智能搜索"]')!
  act(() => resize(1700))
  fireEvent.click(screen.getByRole('button', { name: '放大搜索面板' }))
  act(() => resize(1000))
  fireEvent.click(screen.getByRole('button', { name: '还原搜索面板' }))
  expect(right()).not.toHaveAttribute('hidden')
  expect(left()).toHaveAttribute('hidden')
  vi.unstubAllGlobals()
})

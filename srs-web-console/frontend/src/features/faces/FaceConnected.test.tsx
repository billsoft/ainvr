import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { faceService } from '@/api/faceService'
import { channelService } from '@/api/channelService'
import { aiChannelService } from '@/api/aiChannelService'
import { FaceAlarmEvidence, faceAlarmSummary } from './FaceAlarmEvidence'
import { FaceLibraryConnected } from './FaceLibraryConnected'
import { FaceQueryConnected } from './FaceQueryConnected'
import { FaceMemberPhoto } from './FaceMemberPhoto'
import { FaceLiveResults, FaceMode, FaceRuntimeState } from './FaceConnectedShared'
import type { FaceLibrary, FaceRecord } from '@/api/faceService'
vi.mock('@/api/aiChannelService', () => ({ aiChannelService: { get: vi.fn(async (id: string) => ({ id, config: { stream: { url: 'rtmp://127.0.0.1/live/door' } } })) } }))
vi.mock('@/api/channelService', () => ({ channelService: { list: vi.fn(async () => [{ id: '22222222-2222-4222-a222-222222222222', name: '门口', upstream: { app: 'live', stream: 'door' } }]) } }))
vi.mock('@/api/faceService', () => ({
  faceError: (error: Error) => error.message,
  readFaceJpeg: vi.fn(async () => '/9j/2Q=='),
  faceService: { status: vi.fn(), libraries: vi.fn(), channels: vi.fn(), save: vi.fn(), library: vi.fn(), enroll: vi.fn(), history: vi.fn(), search: vi.fn(), cancel: vi.fn(), record: vi.fn(), recordPhoto: vi.fn(), historicalMemberPhoto: vi.fn(), memberPhoto: vi.fn() },
}))
const channel = '11111111-1111-4111-a111-111111111111'
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(faceService.status).mockResolvedValue({ ready: false, reason: 'extractor_unavailable', active_model: 'mbf', accuracy_verified: false, spaces: [] })
  vi.mocked(faceService.libraries).mockResolvedValue({ items: [], limits: { libraries: 16, members: 500 } })
  vi.mocked(faceService.channels).mockResolvedValue({ items: [{ id: channel, name: '实际输出通道' }] })
  vi.mocked(faceService.historicalMemberPhoto).mockResolvedValue(null)
  vi.mocked(faceService.memberPhoto).mockResolvedValue(null)
  vi.mocked(faceService.cancel).mockResolvedValue({ cancelled: true })
})
afterEach(() => { cleanup(); vi.unstubAllEnvs() })
it('real library CAS conflict and close/continue retain entered fields', async () => {
  vi.mocked(faceService.save).mockRejectedValue(Object.assign(new Error('版本冲突'), { status: 409, code: 'version_conflict' }))
  render(<MemoryRouter><FaceLibraryConnected /></MemoryRouter>)
  await waitFor(() => expect(screen.getByRole('button', { name: /^新建人脸库$/ })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: /^新建人脸库$/ }))
  fireEvent.change(screen.getByLabelText('库名称'), { target: { value: '保留我的输入' } })
  fireEvent.click(screen.getByLabelText('实际输出通道'))
  fireEvent.click(screen.getByRole('button', { name: /^保存库配置$/ }))
  expect(await screen.findByText(/保存发生冲突/)).toBeInTheDocument()
  expect(screen.getByLabelText('库名称')).toHaveValue('保留我的输入')
  fireEvent.click(screen.getByRole('button', { name: /^关闭$/ }))
  fireEvent.click(screen.getByRole('button', { name: /^继续编辑$/ }))
  expect(screen.getByLabelText('库名称')).toHaveValue('保留我的输入')
  expect(faceService.save).toHaveBeenCalledTimes(1)
})
it('choosing JPEG does not upload; explicit search sends it and 503 retains selection', async () => {
  vi.mocked(faceService.search).mockRejectedValue(new Error('硬件暂不可用'))
  render(<FaceQueryConnected mode="search" />)
  await screen.findByLabelText('实际输出通道')
  fireEvent.change(screen.getByLabelText(/选择查询照片/), { target: { files: [new File(['test'], 'explicit-test.jpg', { type: 'image/jpeg' })] } })
  expect(faceService.search).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^上传照片并搜索$/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('硬件暂不可用')
  expect(screen.getByText(/已选择 explicit-test.jpg/)).toBeInTheDocument()
  expect(faceService.search).toHaveBeenCalledWith(expect.objectContaining({ model: 'mbf', jpeg_base64: '/9j/2Q==', scope: expect.objectContaining({ channel_ids: [channel] }) }), expect.any(AbortSignal))
})
it('production mode hides design examples and results use channel names plus the existing playback link', async () => {
  vi.stubEnv('DEV', false)
  const record: FaceRecord = { id: channel, channel_id: channel, processor_id: 'test', session_id: 'test', track_id: 'test', captured_at: '2026-11-12T10:00:00.000Z', expires_at: '2026-11-13T10:00:00.000Z', model: 'mbf', space_id: 'a'.repeat(64), photo_ref: channel, quality: { state: 'qualified', reason: 'test geometry' }, match: { state: 'unmatched', reason: 'test below threshold' }, recording_channel_id: channel }
  vi.mocked(faceService.recordPhoto).mockResolvedValue(null)
  render(<MemoryRouter><FaceMode preview={<p>隔离示例</p>}><FaceLiveResults records={[record]} coverage="unknown" channelNames={{ [channel]: '实际输出通道' }} /></FaceMode></MemoryRouter>)
  expect(screen.queryByRole('button', { name: /设计预览/ })).toBeNull()
  expect(screen.queryByText('隔离示例')).toBeNull()
  expect(screen.getByRole('article', { name: '实际输出通道' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^查看抓拍详情$/ }))
  const link = screen.getByRole('link', { name: /^查看前后录像$/ })
  expect(link.getAttribute('href')).toContain(`/playback/${channel}?from=`)
  expect(link.getAttribute('href')).toContain('&autoplay=1')
  expect(screen.queryByText(record.space_id, { exact: false })).toBeNull()
  expect(screen.getByText('记录编号').closest('details')).not.toHaveAttribute('open')
  await act(async () => {})
})

it('face alarm evidence uses the protected capture and preserves the recording drilldown', async () => {
  const face = { record_id: channel, channel_id: channel, library_id: channel, library_version: 3, library_name: '授权库', member_id: channel, member_name: '候选姓名', similarity: 0.92, threshold: 0.9, model: 'mbf', space_id: 'a'.repeat(64), occurred_at: '2026-11-12T10:00:00.000Z', recording_channel_id: channel }
  vi.mocked(faceService.record).mockResolvedValue({ id: channel, recording_channel_id: channel, captured_at: face.occurred_at, expires_at: '2026-11-13T10:00:00.000Z' } as FaceRecord)
  vi.mocked(faceService.recordPhoto).mockResolvedValue(null)
  render(<MemoryRouter><FaceAlarmEvidence face={face} /></MemoryRouter>)
  expect(faceAlarmSummary(face)).toBe('疑似「候选姓名」 · 人脸库「授权库」 · 候选相似度 0.92（仅供参考，需人工确认）')
  expect(screen.queryByText(/MBF|aaaaaaaa/)).toBeNull()
  const link = await screen.findByRole('link', { name: '查看抓拍前后录像' })
  expect(link.getAttribute('href')).toContain(`/playback/${channel}?from=`)
  expect(faceService.record).toHaveBeenCalledWith(channel, expect.any(AbortSignal))
  expect(faceService.recordPhoto).toHaveBeenCalledWith(channel, expect.any(AbortSignal))
  expect(faceService.historicalMemberPhoto).toHaveBeenCalledWith(channel, 3, channel, channel, expect.any(AbortSignal))
  expect(faceService.memberPhoto).not.toHaveBeenCalled()
  expect(screen.getByText('当时的名单参考照')).toBeInTheDocument()
})
it('expired alarm evidence keeps candidate facts but does not fabricate a recording link', async () => {
  vi.mocked(faceService.record).mockRejectedValue(Error('证据已过期'))
  vi.mocked(faceService.recordPhoto).mockResolvedValue(null)
  render(<MemoryRouter><FaceAlarmEvidence face={{ record_id: channel, channel_id: channel, library_id: channel, library_version: 1, member_id: channel, similarity: 0.9, threshold: 0.8, model: 'mbf', space_id: 'a'.repeat(64), occurred_at: '2026-11-12T10:00:00.000Z', recording_channel_id: channel }} /></MemoryRouter>)
  expect(await screen.findByRole('status')).toHaveTextContent('证据已过期')
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText(/告警阈值 0.8 · 比对时名单为第 1 版/)).toBeInTheDocument()
})

const second = '22222222-2222-4222-a222-222222222222'
const emptyPage = { scope: { channel_ids: [], from: '', to: '' }, model: 'mbf' as const, space_id: 'a'.repeat(64), items: [], next_cursor: null, coverage: 'unknown' as const }
it('face history starts scoped to the channel chosen on the page, by input or analysis channel', async () => {
  vi.mocked(faceService.channels).mockResolvedValue({ items: [{ id: channel, name: '大厅' }, { id: second, name: '门口' }] })
  vi.mocked(faceService.history).mockResolvedValue(emptyPage)
  const view = render(<MemoryRouter><FaceQueryConnected mode="history" channelId={second} /></MemoryRouter>)
  await waitFor(() => expect(screen.getByLabelText('门口')).toBeChecked())
  expect(screen.getByLabelText('大厅')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '查询抓拍历史' }))
  await waitFor(() => expect(faceService.history).toHaveBeenCalled())
  expect(vi.mocked(faceService.history).mock.calls[0]![0].scope.channel_ids).toEqual([second])
  view.unmount()
  render(<MemoryRouter><FaceQueryConnected mode="history" channelId="analysis-door" /></MemoryRouter>)
  await waitFor(() => expect(screen.getByLabelText('门口')).toBeChecked())
  expect(screen.getByLabelText('大厅')).not.toBeChecked()
})
it('face queries follow the feature model the device is running', async () => {
  vi.mocked(faceService.status).mockResolvedValue({ ready: true, reason: null, accuracy_verified: false, active_model: 'r50', desired_model: 'r50', spaces: [] })
  vi.mocked(faceService.history).mockResolvedValue({ ...emptyPage, model: 'r50' })
  render(<MemoryRouter><FaceQueryConnected mode="history" /></MemoryRouter>)
  await waitFor(() => expect(screen.getByLabelText('实际输出通道')).toBeChecked())
  await waitFor(() => expect(faceService.status).toHaveBeenCalled())
  await new Promise(resolve => setTimeout(resolve, 0))
  fireEvent.click(screen.getByRole('button', { name: '查询抓拍历史' }))
  await waitFor(() => expect(faceService.history).toHaveBeenCalled())
  expect(vi.mocked(faceService.history).mock.calls[0]![0].model).toBe('r50')
  expect(screen.queryByText(/MBF|R50/)).toBeNull()
})
it('face result list loads a protected thumbnail for each capture without opening details', async () => {
  const record: FaceRecord = { id: channel, channel_id: channel, processor_id: 'test', session_id: 'test', track_id: 'test', captured_at: '2026-11-12T10:00:00.000Z', expires_at: '2026-11-13T10:00:00.000Z', model: 'mbf', space_id: 'a'.repeat(64), photo_ref: channel, quality: { state: 'qualified', reason: 'test geometry' }, match: { state: 'unmatched', reason: 'test below threshold' }, recording_channel_id: channel }
  vi.mocked(faceService.recordPhoto).mockResolvedValue(null)
  render(<MemoryRouter><FaceLiveResults records={[record, { ...record, id: second, photo_ref: null }]} coverage="unknown" /></MemoryRouter>)
  await waitFor(() => expect(faceService.recordPhoto).toHaveBeenCalledWith(channel, expect.any(AbortSignal)))
  expect(faceService.recordPhoto).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('button', { name: /^放大抓拍/ })).toHaveLength(2)
  expect(screen.getByText('照片已清理')).toBeInTheDocument()
  expect(await screen.findByText('照片不可用')).toBeInTheDocument()
  expect(screen.queryByText('读取中…')).toBeNull()
})

it('an unresolved page channel never silently widens the query to all channels', async () => {
  vi.mocked(aiChannelService.get).mockRejectedValueOnce(Error('通道读取失败'))
  render(<MemoryRouter><FaceQueryConnected mode="history" channelId="missing-analysis" /></MemoryRouter>)
  expect(await screen.findByText(/不会自动扩大范围/)).toBeInTheDocument()
  expect(screen.getByLabelText('实际输出通道')).not.toBeChecked()
  expect(screen.getByRole('button', { name: '查询抓拍历史' })).toBeDisabled()
  expect(faceService.history).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('实际输出通道'))
  expect(screen.getByRole('button', { name: '查询抓拍历史' })).not.toBeDisabled()
})

it('queries wait for model settings instead of sending an early default MBF request', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof faceService.status>>) => void
  vi.mocked(faceService.status).mockImplementation(() => new Promise(done => { resolve = done }))
  render(<MemoryRouter><FaceQueryConnected mode="history" /></MemoryRouter>)
  await screen.findByLabelText('实际输出通道')
  expect(screen.getByRole('button', { name: '查询抓拍历史' })).toBeDisabled()
  await act(async () => resolve({ ready: true, active_model: 'r50', accuracy_verified: false, reason: null, spaces: [] }))
  vi.mocked(faceService.history).mockResolvedValue({ ...emptyPage, model: 'r50' })
  fireEvent.click(screen.getByRole('button', { name: '查询抓拍历史' }))
  await waitFor(() => expect(faceService.history).toHaveBeenCalledWith(expect.objectContaining({ model: 'r50' }), expect.any(AbortSignal)))
})

it('failed model settings remain retryable and never fall back to an invented model', async () => {
  vi.mocked(faceService.status).mockRejectedValue(Error('连接中断'))
  render(<MemoryRouter><FaceQueryConnected mode="history" /></MemoryRouter>)
  expect(await screen.findByText(/无法读取抓拍设置/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查询抓拍历史' })).toBeDisabled()
  vi.mocked(faceService.status).mockResolvedValue({ ready: true, active_model: 'r50', accuracy_verified: false, reason: null, spaces: [] })
  fireEvent.click(screen.getByRole('button', { name: '重新读取设置' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '查询抓拍历史' })).not.toBeDisabled())
  expect(screen.queryByText(/无法读取抓拍设置/)).toBeNull()
})

it('switching page channels cancels the old query while new scope is loading', async () => {
  let finish!: (value: typeof emptyPage) => void
  vi.mocked(faceService.history).mockImplementation(() => new Promise(done => { finish = done }))
  const view = render(<MemoryRouter><FaceQueryConnected mode="history" channelId={channel} /></MemoryRouter>)
  await waitFor(() => expect(screen.getByRole('button', { name: '查询抓拍历史' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '查询抓拍历史' }))
  const signal = vi.mocked(faceService.history).mock.calls[0]![1]!
  vi.mocked(faceService.channels).mockImplementationOnce(() => new Promise(() => undefined))
  view.rerender(<MemoryRouter><FaceQueryConnected mode="history" channelId={second} /></MemoryRouter>)
  expect(signal.aborted).toBe(true)
  expect(screen.getByRole('button', { name: '查询抓拍历史' })).toBeDisabled()
  await act(async () => finish(emptyPage))
  expect(screen.queryByRole('region', { name: '设备人脸结果' })).toBeNull()
})

it('historical member photos never fall back to the current photo, and changes abort old requests', async () => {
  let finish!: (value: Blob | null) => void
  vi.mocked(faceService.historicalMemberPhoto).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<FaceMemberPhoto libraryId={channel} version={3} memberId={channel} recordId={channel} />)
  const signal = vi.mocked(faceService.historicalMemberPhoto).mock.calls[0]![4]!
  view.rerender(<FaceMemberPhoto libraryId={channel} version={4} memberId={channel} recordId={channel} />)
  expect(signal.aborted).toBe(true)
  expect(await screen.findByText(/无法进行照片核对/)).toBeInTheDocument()
  await act(async () => finish(null))
  expect(faceService.memberPhoto).not.toHaveBeenCalled()
  expect(faceService.historicalMemberPhoto).toHaveBeenLastCalledWith(channel, 4, channel, channel, expect.any(AbortSignal))
})
it('a configuration revision refreshes runtime state and follows eventual application with bounded polling', async () => {
  vi.useFakeTimers()
  try {
    vi.mocked(faceService.status).mockResolvedValue({ ready: false, reason: 'not_configured', accuracy_verified: false, spaces: [] })
    const view = render(<FaceRuntimeState />)
    await act(async () => {})
    expect(screen.getByText('人脸比对尚未启用')).toBeInTheDocument()
    view.rerender(<FaceRuntimeState revision={1} />)
    await act(async () => {})
    vi.mocked(faceService.status).mockResolvedValue({ ready: true, reason: null, accuracy_verified: false, spaces: [] })
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByText('人脸比对可用')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(35000))
    const calls = vi.mocked(faceService.status).mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(60000))
    expect(faceService.status).toHaveBeenCalledTimes(calls)
    view.unmount()
  } finally { vi.useRealTimers() }
})

it('saving a library refreshes status and unuploaded photo selections cannot be silently discarded', async () => {
  const library = { id: channel, version: 1, document: { name: '门口名单', model: 'mbf' as const, channel_ids: [channel], valid_until: '2030-01-01T00:00:00.000Z', retention_days: 30, match_requested: false, match_threshold: null, access: 'console-management' as const, members: [{ id: second, name: '成员', note: '', template_id: null }] }, templates: {}, updated_at: '2026-11-13T00:00:00.000Z', runtime_note: '' }
  vi.mocked(faceService.libraries).mockResolvedValue({ items: [library], limits: { libraries: 16, members: 500 } })
  vi.mocked(faceService.save).mockResolvedValue({ ...library, version: 2 })
  render(<MemoryRouter><FaceLibraryConnected /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '编辑库' }))
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [new File(['test'], 'pending.jpg', { type: 'image/jpeg' })] } })
  fireEvent.click(screen.getByRole('button', { name: '保存库配置' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('已选择但未上传')
  expect(faceService.save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [] } })
  const before = vi.mocked(faceService.status).mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: '保存库配置' }))
  expect(await screen.findByText(/保存不等于立即生效/)).toBeInTheDocument()
  await waitFor(() => expect(vi.mocked(faceService.status).mock.calls.length).toBeGreaterThan(before))
})

function registrationLibrary(): FaceLibrary {
  return { id: channel, version: 1, document: { name: '登记测试库', model: 'mbf', channel_ids: [channel], valid_until: '2030-01-01T00:00:00.000Z', retention_days: 7, match_requested: true, match_threshold: 0.9, access: 'console-management', members: [{ id: second, name: '登记成员', note: '', template_id: second }] }, templates: { [second]: { template_id: second, photo_ref: second, model: 'mbf', space_id: 'a'.repeat(64), quality: { state: 'qualified', reason: null }, expires_at: '2029-01-01T00:00:00.000Z' } }, updated_at: '2026-11-13T00:00:00.000Z', runtime_note: '' }
}
it('registration settings must be saved before upload; clearing a chosen file unlocks save without extending old evidence', async () => {
  const library = registrationLibrary(), originalExpiry = library.templates[second]!.expires_at
  vi.mocked(faceService.libraries).mockResolvedValue({ items: [library], limits: { libraries: 16, members: 500 } })
  vi.mocked(faceService.channels).mockResolvedValue({ items: [{ id: channel, name: '实际输出通道' }, { id: second, name: '第二通道' }] })
  vi.mocked(faceService.save).mockImplementation(async (_id, version, document) => ({ ...library, version: version + 1, document }))
  render(<MemoryRouter><FaceLibraryConnected /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '编辑库' }))
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [new File(['test'], 'retained.jpg', { type: 'image/jpeg' })] } })
  fireEvent.change(screen.getByLabelText('后续照片保留天数'), { target: { value: '90' } })
  expect(screen.getByRole('button', { name: '上传照片' })).toBeDisabled()
  expect(screen.getByText(/登记设置尚未保存/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存库配置' }))
  expect(faceService.save).not.toHaveBeenCalled(); expect(faceService.enroll).not.toHaveBeenCalled()
  const clear = screen.getByRole('button', { name: '清除已选照片 1' })
  expect(clear).toHaveClass('min-h-11'); fireEvent.click(clear)
  expect(screen.getByLabelText('成员照片 1')).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: '保存库配置' }))
  await screen.findByText(/保存不等于立即生效/)
  expect(faceService.save).toHaveBeenLastCalledWith(channel, 1, expect.objectContaining({ retention_days: 90, members: library.document.members }), expect.any(String))
  expect(library.templates[second]!.expires_at).toBe(originalExpiry)
  fireEvent.click(screen.getByRole('button', { name: '编辑库' }))
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [new File(['test'], 'retained.jpg', { type: 'image/jpeg' })] } })
  expect(screen.getByRole('button', { name: '上传照片' })).not.toBeDisabled()
  vi.mocked(faceService.enroll).mockResolvedValueOnce({ ...library.templates[second]!, template_id: channel, photo_ref: channel, expires_at: '2029-03-01T00:00:00.000Z' })
  fireEvent.click(screen.getByRole('button', { name: '上传照片' }))
  await waitFor(() => expect(faceService.enroll).toHaveBeenCalledWith(channel, second, expect.objectContaining({ expected_version: 2, model: 'mbf', jpeg_base64: '/9j/2Q==' })))
  await waitFor(() => expect(screen.getByRole('button', { name: '保存库配置' })).not.toBeDisabled())
  expect(library.templates[second]!.expires_at).toBe(originalExpiry)
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [new File(['test'], 'next.jpg', { type: 'image/jpeg' })] } })
  fireEvent.change(screen.getByLabelText('比对精度'), { target: { value: 'r50' } })
  expect(screen.getByRole('button', { name: '上传照片' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('比对精度'), { target: { value: 'mbf' } })
  fireEvent.click(screen.getByLabelText('第二通道'))
  expect(screen.getByRole('button', { name: '上传照片' })).toBeDisabled()
  fireEvent.click(screen.getByLabelText('第二通道'))
  fireEvent.change(screen.getByLabelText('名单有效期'), { target: { value: '2031-01-01' } })
  expect(screen.getByRole('button', { name: '上传照片' })).toBeDisabled()
  expect(faceService.enroll).toHaveBeenCalledTimes(1)
})
it('refreshed active space marks old same-model members for registration and model errors are not CAS conflicts', async () => {
  const library = registrationLibrary(), original = structuredClone(library.templates)
  const space = (pin: string) => ({ model: 'mbf' as const, space_id: pin.repeat(64), dimensions: 512, alignment_version: 'test', metric: 'cosine' as const, active: true })
  vi.mocked(faceService.libraries).mockResolvedValue({ items: [library], limits: { libraries: 16, members: 500 } })
  vi.mocked(faceService.status).mockResolvedValue({ ready: true, reason: null, accuracy_verified: false, active_model: 'mbf', spaces: [space('a')] })
  render(<MemoryRouter><FaceLibraryConnected /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '编辑库' }))
  expect(screen.queryByText(/模型已更新，请重新上传照片/)).toBeNull()
  vi.mocked(faceService.status).mockResolvedValue({ ready: true, reason: null, accuracy_verified: false, active_model: 'mbf', spaces: [{ ...space('a'), active: false }, space('b')] })
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
  expect(await screen.findByText('模型已更新，请重新上传照片以重新登记；原照片按原期限保留。')).toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: library.document.name })).getByText(/1 位成员需要重新登记/)).toBeInTheDocument()
  expect(library.templates).toEqual(original); expect(faceService.enroll).not.toHaveBeenCalled(); expect(faceService.save).not.toHaveBeenCalled()
  vi.mocked(faceService.enroll).mockRejectedValueOnce(Object.assign(Error('当前模型与所选空间不一致'), { status: 409, code: 'model_space_mismatch' }))
  fireEvent.change(screen.getByLabelText('成员照片 1'), { target: { files: [new File(['test'], 'new-space.jpg', { type: 'image/jpeg' })] } })
  fireEvent.click(screen.getByRole('button', { name: '上传照片' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('当前模型与所选空间不一致')
  expect(screen.queryByText(/保存发生冲突/)).toBeNull()
  expect(screen.getByRole('button', { name: '保存库配置' })).not.toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '清除已选照片 1' }))
  vi.mocked(faceService.save).mockRejectedValueOnce(Object.assign(Error('其他库模型冲突'), { status: 409, code: 'faces_model_conflict' }))
  fireEvent.click(screen.getByRole('button', { name: '保存库配置' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('其他库模型冲突')
  expect(screen.queryByText(/保存发生冲突/)).toBeNull()
})

it('analysis history selects its eligible output, not an unrelated channel or only its input',async()=>{
 vi.mocked(faceService.channels).mockResolvedValue({items:[{id:channel,name:'实际输出通道'},{id:second,name:'其他通道'}]})
 vi.mocked(aiChannelService.get).mockResolvedValueOnce({id:'analysis-output',config:{stream:{url:'rtmp://127.0.0.1/live/input'},publish:{enabled:true,target_url:'rtmp://127.0.0.1/live/output'}}} as never)
 vi.mocked(channelService.list).mockResolvedValueOnce([{id:channel,upstream:{app:'live',stream:'output'}},{id:second,upstream:{app:'live',stream:'other'}}] as never)
 render(<MemoryRouter><FaceQueryConnected mode="history" channelId="analysis-output"/></MemoryRouter>)
 await waitFor(()=>expect(screen.getByLabelText('实际输出通道')).toBeChecked())
 expect(screen.getByLabelText('其他通道')).not.toBeChecked()
 expect(screen.queryByText(/当前通道未匹配/)).not.toBeInTheDocument()
})

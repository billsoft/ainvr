import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import SearchPage from '@/pages/Search'
import type { SearchPageResult } from '@/api/searchService'
import { searchService } from '@/api/searchService'
import { requestBlob } from '@/api/httpClient'
import * as reference from '@/features/searchReference'

vi.mock('@/api/searchService', async original => ({ ...await original<typeof import('@/api/searchService')>(), searchService: { coverage: vi.fn(), status: vi.fn(), channels: vi.fn(), query: vi.fn(), imageQuery: vi.fn(), page: vi.fn(), detail: vi.fn(), cancel: vi.fn(), feedback: vi.fn() } }))
vi.mock('@/api/httpClient', async original => ({ ...await original<typeof import('@/api/httpClient')>(), requestBlob: vi.fn() }))
vi.mock('@/pages/Search/aiReference', () => ({ aiReferenceEnabled: () => false }))
vi.mock('@/components/common/AuthImage', () => ({ AuthImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} /> }))
// jsdom has neither image decoding nor canvas: the picture pipeline is replaced at its boundary only.
vi.mock('@/features/searchReference', async original => {
  const actual = await original<typeof import('@/features/searchReference')>()
  return { ...actual,
    loadReference: vi.fn(async (blob: Blob, origin: 'upload' | 'result', crop = null) => {
      actual.checkReferenceFile(blob)
      return { blob, url: `blob:${(blob as File).name ?? 'evidence'}`, width: 1600, height: 1200, crop, origin }
    }),
    encodeReference: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
    blobToBase64: vi.fn(async () => 'SlBFRw==') }
})

const page = (items: SearchPageResult['items'] = []): SearchPageResult => ({ search_id: '00000000-0000-4000-8000-000000000001', model_version: 'm',
  scope: { channel_ids: ['a'], from: '2026-11-12T00:00:00.000Z', to: '2026-11-13T00:00:00.000Z' }, coverage: 'sampled', items, next_cursor: null })
const result = (id: string): SearchPageResult['items'][number] => ({ id, channel_id: 'a', channel_name: '后门', similarity: 0.71, source_input_id: id, processor_id: null,
  output_channel_id: 'a', kind: 'object', started_at: '2026-11-12T08:00:00.000Z', ended_at: '2026-11-12T08:00:05.000Z',
  frames: [{ id: `${id}-f`, captured_at: '2026-11-12T08:00:01.000Z', role: 'match', bbox: [0.25, 0.1, 0.2, 0.5] }],
  recording: { channel_id: 'a', state: 'available' }, verification: { state: 'candidate' }, feedback: null })

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom has no object URLs; the real release logic runs against this stub.
  URL.revokeObjectURL = vi.fn()
  vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: 'm' })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: 'a', name: '后门' }] })
  vi.mocked(searchService.coverage).mockImplementation(async scope => ({ scope, state: 'sampled', ranges: [] }))
  vi.mocked(searchService.cancel).mockResolvedValue({ cancelled: true })
})
async function addFile(name = 'bag.jpg', type = 'image/jpeg') {
  fireEvent.change(screen.getByTestId('search-reference-file'), { target: { files: [new File(['x'], name, { type })] } })
}

it('searches with a picture alone, keeps the text path unchanged and shows what was searched', async () => {
  vi.mocked(searchService.imageQuery).mockResolvedValue(page([result('00000000-0000-4000-8000-0000000000aa')]))
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  const submit = screen.getByRole('button', { name: '搜索录像' })
  expect(submit).toBeDisabled()
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveAttribute('placeholder', '描述衣着、颜色或物品，也可以添加图片')
  await addFile()
  expect(await screen.findByRole('group', { name: '参考图片' })).toHaveTextContent('使用整张图片')
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveAttribute('placeholder', '补充描述（可选），例如：有人背着这个包')
  expect(screen.queryByRole('button', { name: '添加图片' })).not.toBeInTheDocument()
  expect(submit).toBeEnabled()
  fireEvent.click(submit)
  await screen.findByText(/本次搜索：参考图片/)
  const input = vi.mocked(searchService.imageQuery).mock.calls[0]![0]
  expect(input).toMatchObject({ query: '', image: 'SlBFRw==' })
  expect(input).not.toHaveProperty('image_weight')
  expect(input).not.toHaveProperty('min_similarity')
  expect(searchService.query).not.toHaveBeenCalled()
  expect(screen.getByText('按外观相似度排序')).toBeInTheDocument()
  expect(screen.getByText('外观相似度 0.710')).toBeInTheDocument()
})

it('combines picture and description with an adjustable share, and marks changed conditions', async () => {
  vi.mocked(searchService.imageQuery).mockResolvedValue(page([result('00000000-0000-4000-8000-0000000000aa')]))
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  await addFile()
  await screen.findByRole('group', { name: '参考图片' })
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '戴这条围巾的人' } })
  fireEvent.change(screen.getByRole('slider', { name: '图片与文字的侧重' }), { target: { value: '0.7' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByText(/本次搜索：参考图片 ＋ “戴这条围巾的人”/)
  expect(vi.mocked(searchService.imageQuery).mock.calls[0]![0]).toMatchObject({ query: '戴这条围巾的人', image_weight: 0.7 })
  expect(screen.getByText('按相关性排序')).toBeInTheDocument()
  expect(screen.getAllByText('图文综合排序').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '移除' }))
  expect(screen.getByText(/条件已修改/)).toBeInTheDocument()
  // The summary still shows the picture that was actually searched.
  expect(screen.getByText(/本次搜索：参考图片/)).toBeInTheDocument()
})

it('selects part of the picture, keeps the confirmed selection on cancel and can return to the whole picture', async () => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  await addFile()
  fireEvent.click(await screen.findByRole('button', { name: '框选目标' }))
  let dialog = screen.getByRole('dialog', { name: '框选要找的目标' })
  fireEvent.click(within(dialog).getByRole('button', { name: '使用选区' }))
  expect(screen.getByRole('group', { name: '参考图片' })).toHaveTextContent('仅搜索选区')
  fireEvent.click(screen.getByRole('button', { name: '调整选区' }))
  dialog = screen.getByRole('dialog', { name: '框选要找的目标' })
  // Escape closes an unchanged draft and preserves the confirmed selection.
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '调整选区' }))
  dialog = screen.getByRole('dialog', { name: '框选要找的目标' })
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('group', { name: '参考图片' })).toHaveTextContent('仅搜索选区')
  fireEvent.click(screen.getByRole('button', { name: '调整选区' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '使用整图' }))
  expect(screen.getByRole('group', { name: '参考图片' })).toHaveTextContent('使用整张图片')
})

it.each(['Escape', '关闭', '取消'])('protects a modified selection on %s and restores focus after discarding', async close => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  await addFile()
  const opener = await screen.findByRole('button', { name: '框选目标' })
  opener.focus(); fireEvent.click(opener)
  const surface = screen.getByRole('group', { name: /选区，方向键移动/ })
  fireEvent.keyDown(surface, { key: 'ArrowRight' })
  const changed = surface.getAttribute('aria-description')
  if (close === 'Escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: close }))
  expect(screen.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(surface.getAttribute('aria-description')).toBe(changed)
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(opener).toHaveFocus()
  expect(screen.getByRole('group', { name: '参考图片' })).toHaveTextContent('使用整张图片')
})

it('keeps the picture shown after selecting part of it and after searching again with another selection', async () => {
  vi.mocked(searchService.imageQuery).mockResolvedValue(page([result('00000000-0000-4000-8000-0000000000aa')]))
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  await addFile('bag.jpg')
  fireEvent.click(await screen.findByRole('button', { name: '框选目标' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '使用选区' }))
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await screen.findByText(/本次搜索：参考图片（局部）/)
  fireEvent.click(screen.getByRole('button', { name: '调整选区' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '使用整图' }))
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  await waitFor(() => expect(searchService.imageQuery).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByText(/本次搜索：参考图片/).textContent).not.toContain('局部'))
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:bag.jpg')
  // Replacing the picture releases the old one once nothing shows it.
  fireEvent.click(screen.getByRole('button', { name: '移除' }))
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:bag.jpg')
  await addFile('other.png', 'image/png')
  fireEvent.click(await screen.findByRole('button', { name: '搜索录像' }))
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:bag.jpg'))
})

it('explains an unsupported picture where it was added and keeps the description', async () => {
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '白色汽车' } })
  await addFile('a.gif', 'image/gif')
  expect(await screen.findByRole('alert')).toHaveTextContent('请使用 JPEG 或 PNG 图片')
  expect(screen.getByRole('textbox', { name: '想找什么？' })).toHaveValue('白色汽车')
  expect(screen.queryByRole('group', { name: '参考图片' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '搜索录像' })).toBeEnabled()
})

it('brings a result picture into the conditions with its target preselected, without searching', async () => {
  vi.mocked(searchService.query).mockResolvedValue(page([result('00000000-0000-4000-8000-0000000000aa')]))
  vi.mocked(requestBlob).mockResolvedValue(new Blob(['evidence'], { type: 'image/jpeg' }))
  render(<MemoryRouter><SearchPage /></MemoryRouter>)
  await screen.findByRole('checkbox', { name: '后门' })
  fireEvent.change(screen.getByRole('textbox', { name: '想找什么？' }), { target: { value: '背黑色双肩包的人' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索录像' }))
  fireEvent.click(await screen.findByRole('button', { name: /查看第 1 条候选/ }))
  fireEvent.click(screen.getByRole('button', { name: '用此图查找' }))
  const strip = await screen.findByRole('group', { name: '参考图片' })
  expect(strip).toHaveTextContent('仅搜索选区')
  expect(strip).toHaveTextContent('来自搜索结果')
  expect(vi.mocked(reference.loadReference).mock.calls[0]![2]).toEqual({ x: 0.25, y: 0.1, w: 0.2, h: 0.5 })
  expect(searchService.imageQuery).not.toHaveBeenCalled()
  expect(searchService.query).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.getByText(/条件已修改/)).toBeInTheDocument())
})

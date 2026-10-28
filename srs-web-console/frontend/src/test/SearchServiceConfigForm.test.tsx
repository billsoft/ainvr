import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchServiceConfigForm } from '@/pages/ConfigCenter/SearchServiceConfigForm'
import { searchService } from '@/api/searchService'
import type { ConfigDocument } from '@/api/configService'

vi.mock('@/api/searchService', () => ({ searchService: { models: vi.fn(), channels: vi.fn(), status: vi.fn() } }))
vi.mock('@/api/storageService', () => ({ storageBytes: () => '80 GB', storageService: {
  volumes: async () => ({ volumes: [{ id: 'ssd-uuid', device: '/dev/test', label: '外置 SSD', transport: 'usb', mountPath: '/media/external', system: false, selectable: true, availableBytes: 1 }] }),
  directories: async () => ({ directories: [], truncated: false }),
} }))
const source = '00000000-0000-4000-8000-000000000001'
const stored = (config: Record<string, unknown>): ConfigDocument => ({ id: 1, service: 'search-service', group: 'system', name: 'settings', config, createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T01:00:00Z' })
function open(config?: ConfigDocument, save = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<MemoryRouter><SearchServiceConfigForm document={config} onSaveBatch={save} /></MemoryRouter>)
  return { ...view, save }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(searchService.models).mockResolvedValue({ items: [], service_ready: true, reason: null })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: source, name: '后门 AI 输出' }] })
  vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'disabled', model_version: null })
})
describe('智能搜索配置', () => {
  it('uses a disabled draft and real empty model catalog, without editable credentials or paths', async () => {
    open()
    await screen.findByText('智能搜索未启用')
    expect(screen.getByRole('checkbox', { name: '启用智能搜索' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '保存并应用' })).not.toBeDisabled()
    expect(screen.getByText('尚未发现可用模型包，可先保存关闭状态。')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '搜索模型包' }).querySelectorAll('option')).toHaveLength(2)
    expect(screen.queryByLabelText(/密钥|密码|HBM/)).not.toBeInTheDocument()
  })
  it('allows saving a disabled configuration without installing models, and only the selected service is changed', async () => {
    const { save, container } = open()
    await screen.findByText('智能搜索未启用')
    fireEvent.change(screen.getByRole('spinbutton', { name: '搜索保留时间（天）' }), { target: { value: '14' } })
    expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [change] = save.mock.calls[0]![0]
    expect(change).toMatchObject({ service: 'search-service', group: 'system', name: 'settings', config: {
      enabled: false, callers: [], history: { source: 'ai-history' }, limits: { retention_days: 14 }, sampling: { mode: 'all', channel_ids: [] },
    } })
    expect(JSON.stringify(change)).not.toContain('mongo_uri')
    await waitFor(() => expect(container.querySelector('[data-unsaved="true"]')).toBeNull())
  })
  it('lets an absent document save the disabled default without pretending there is an unsaved edit or application in progress', async () => {
    vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'config_pending', model_version: null })
    const { save, container } = open()
    await screen.findByText('尚未配置，默认关闭')
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ enabled: false, callers: [], model: { package_id: 'siglip-so400m-i18n-full-int8' } })
  })
  it('prevents enabling without a model and external disk instead of claiming readiness', async () => {
    const { save } = open()
    await screen.findByText('智能搜索未启用')
    fireEvent.click(screen.getByRole('checkbox', { name: '启用智能搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(/启用前请选择模型包和外挂存储/)).toBeInTheDocument()
  })
  it('removes the unsaved flag when an operator reverts the draft', async () => {
    const { container } = open(stored({ enabled: false }))
    await screen.findByText('智能搜索未启用')
    fireEvent.click(screen.getByRole('checkbox', { name: '启用智能搜索' }))
    expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: '启用智能搜索' }))
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
    expect(screen.getByRole('button', { name: '保存并应用' })).toBeDisabled()
  })
  it('preserves an unavailable saved model and channel on catalog failure', async () => {
    vi.mocked(searchService.models).mockRejectedValue(new Error('offline'))
    vi.mocked(searchService.channels).mockRejectedValue(new Error('offline'))
    const { save } = open(stored({ model: { package_id: 'siglip2-base-full-int8' }, sampling: { mode: 'selected', channel_ids: [source] } }))
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('siglip2-base-full-int8')
    expect(screen.getByText(/1 个已选通道当前不可用/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: '搜索保留时间（天）' }), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ model: { package_id: 'siglip2-base-full-int8' }, sampling: { channel_ids: [source] } })
  })
  it('defaults new drafts to full-vocabulary INT8 without enabling or marking an edit', async () => {
    vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
    const { container } = open()
    await screen.findByText('模型或索引尚未就绪')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('siglip-so400m-i18n-full-int8')
    expect(screen.getByRole('checkbox', { name: '启用智能搜索' })).not.toBeChecked()
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
    expect(screen.queryByText('模型与索引已就绪')).not.toBeInTheDocument()
  })
  it('preserves an explicitly empty saved model instead of replacing it with the new default', async () => {
    const { container } = open(stored({ model: { package_id: null } }))
    await screen.findByText('智能搜索未启用')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('')
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
  })
  it('keeps the draft after an apply failure and distinguishes applied config from model readiness', async () => {
    const save = vi.fn().mockRejectedValue(new Error('服务未确认应用'))
    vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
    const { container } = open(undefined, save)
    await screen.findByText('模型或索引尚未就绪')
    fireEvent.change(screen.getByRole('spinbutton', { name: '搜索证据容量上限（GB）' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await screen.findByText(/服务未确认应用；输入已保留/)
    expect(screen.getByRole('spinbutton', { name: '搜索证据容量上限（GB）' })).toHaveValue(2)
    expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
  })
  it('stores a stable volume UUID and relative destination, without a mount path', async () => {
    const { save } = open()
    await screen.findByRole('option', { name: /外置 SSD/ })
    fireEvent.change(screen.getByRole('combobox', { name: '选择索引磁盘' }), { target: { value: 'ssd-uuid' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此目录' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '使用此目录' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config.index_storage).toEqual({ volume_id: 'ssd-uuid', relative_path: 'ainvr/search-index' })
    expect(JSON.stringify(save.mock.calls[0])).not.toContain('/media/external')
  })
  it('distinguishes Mongo evidence limits from the derived SSD index and explains capacity backpressure', async () => {
    open()
    await screen.findByText('智能搜索未启用')
    expect(screen.getByRole('spinbutton', { name: '搜索证据容量上限（GB）' })).toBeInTheDocument()
    expect(screen.getByText(/下方选择的是外挂 SSD 上的派生索引目录，不会改变 MongoDB 的数据位置或连接/)).toBeInTheDocument()
    expect(screen.getByText(/容量满时暂停新增采集，按保留期清理；已有录像不会删除/)).toBeInTheDocument()
    expect(screen.queryByText(/清理最旧索引/)).not.toBeInTheDocument()
  })
  it('can save an enabled but pending model without pretending it is searchable', async () => {
    vi.mocked(searchService.models).mockResolvedValue({ items: [{ package_id: 'full-vocab-int8', display_name: '完整词表 INT8', ready: false, reason: 'model_pending', model_version: null, dimensions: 1152 }], service_ready: true, reason: null })
    const { save } = open(stored({ index_storage: { volume_id: 'ssd-uuid', relative_path: 'ainvr/search-index' } }))
    await screen.findByRole('option', { name: '完整词表 INT8 · 待验证' })
    fireEvent.change(screen.getByRole('combobox', { name: '搜索模型包' }), { target: { value: 'full-vocab-int8' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '启用智能搜索' }))
    expect(screen.getByText(/所选模型包尚未通过就绪检查/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ enabled: true, model: { package_id: 'full-vocab-int8' }, callers: [] })
    expect(screen.queryByText('模型与索引已就绪')).not.toBeInTheDocument()
  })
  it('requires at least one selected AI output and supports search without modifying the sampling policy', async () => {
    const { save } = open()
    await screen.findByText('智能搜索未启用')
    fireEvent.click(screen.getByRole('radio', { name: '仅指定通道' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    expect(screen.getByText('请指定 1–100 个 AI 输出通道。')).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: '查找采集通道' }), { target: { value: '后门' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '后门 AI 输出' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config.sampling).toMatchObject({ mode: 'selected', channel_ids: [source], object_interval_ms: 1000, scene_static_interval_ms: 60000 })
  })
})

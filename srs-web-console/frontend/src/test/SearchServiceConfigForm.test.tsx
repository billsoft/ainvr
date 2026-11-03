import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchServiceConfigForm } from '@/pages/ConfigCenter/SearchServiceConfigForm'
import { searchService } from '@/api/searchService'
import { searchCapacityService } from '@/api/searchCapacityService'
import type { ConfigDocument } from '@/api/configService'
import {searchModelMigrationService} from '@/api/searchModelMigrationService'

vi.mock('@/api/searchCapacityService', () => ({ searchCapacityService: { read: vi.fn() } }))
vi.mock('@/api/searchService', () => ({ searchService: { models: vi.fn(), channels: vi.fn(), status: vi.fn() } }))
vi.mock('@/api/searchModelMigrationService',()=>({searchModelMigrationService:{context:vi.fn(),list:vi.fn()}}))
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
  vi.mocked(searchCapacityService.read).mockRejectedValue(new Error('unavailable'))
  vi.mocked(searchModelMigrationService.context).mockResolvedValue({source:null,execution_available:false,reason:'migration_not_ready'})
  vi.mocked(searchModelMigrationService.list).mockResolvedValue({items:[]})
  vi.mocked(searchService.models).mockResolvedValue({ items: [], service_ready: true, reason: null })
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: source, name: '后门 AI 输出' }] })
  vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'disabled', model_version: null })
})
describe('智能搜索配置', () => {
  it('routes a different active model through migration instead of ordinary save',async()=>{
    const hash='a'.repeat(64),other='b'.repeat(64)
    vi.mocked(searchModelMigrationService.context).mockResolvedValue({source:{package_id:'old-model',model_version:`search-v1-${hash}`,package_sha256:hash},execution_available:true,reason:null})
    vi.mocked(searchService.models).mockResolvedValue({items:[{package_id:'new-model',display_name:'New',ready:true,reason:null,model_version:`search-v1-${other}`,dimensions:768}],service_ready:true,reason:null})
    const {save}=open(stored({enabled:true,model:{package_id:'old-model'}}))
    await screen.findByText('当前模型：old-model')
    fireEvent.change(screen.getByRole('combobox',{name:'搜索模型包'}),{target:{value:'new-model'}})
    await screen.findByText(/所选模型与当前空间不同/)
    expect(screen.getByRole('button',{name:'保存并应用'})).toBeDisabled();expect(save).not.toHaveBeenCalled()
  })
  it('detects a new vector space under the same package name without dirtying or replacing the saved selection',async()=>{
    const hash='a'.repeat(64),other='b'.repeat(64)
    vi.mocked(searchModelMigrationService.context).mockResolvedValue({source:{package_id:'same-model',model_version:`search-v1-${hash}`,package_sha256:hash},execution_available:true,reason:null})
    vi.mocked(searchService.models).mockResolvedValue({items:[{package_id:'same-model',display_name:'Same',ready:false,reason:'model_pending',model_version:`search-v1-${other}`,dimensions:768}],service_ready:true,reason:null})
    const {container,save}=open(stored({enabled:true,model:{package_id:'same-model'}}))
    await screen.findByText(/所选模型与当前空间不同/)
    expect(screen.getByRole('combobox',{name:'搜索模型包'})).toHaveValue('same-model');expect(container.querySelector('[data-unsaved="true"]')).toBeNull();expect(save).not.toHaveBeenCalled()
  })
  it('uses a disabled draft and real empty model catalog, without editable credentials or paths', async () => {
    open()
    await screen.findByText('智能搜索未启用')
    expect(screen.getByRole('checkbox', { name: '启用智能搜索' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: '保存并应用' })).not.toBeDisabled()
    expect(screen.getByText('尚未发现模型包文件，可先保存关闭状态。')).toBeInTheDocument()
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
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ enabled: false, callers: [], model: { package_id: 'siglip2-base-full-int8' } })
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
    const { container } = open(stored({ enabled: false, model: { package_id: null } }))
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
    const { save } = open(stored({ model: { package_id: 'siglip-so400m-i18n-full-int8' }, sampling: { mode: 'selected', channel_ids: [source] } }))
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('siglip-so400m-i18n-full-int8')
    expect(screen.getByText(/1 个已选通道当前不可用/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: '搜索保留时间（天）' }), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ model: { package_id: 'siglip-so400m-i18n-full-int8' }, sampling: { channel_ids: [source] } })
  })
  it('defaults new drafts to SigLIP2 Base 256 full-vocabulary INT8 without enabling or marking an edit', async () => {
    vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
    const { container } = open()
    await screen.findByText('模型或索引尚未就绪')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('siglip2-base-full-int8')
    expect(screen.getByRole('checkbox', { name: '启用智能搜索' })).not.toBeChecked()
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
    expect(screen.queryByText('模型与索引已就绪')).not.toBeInTheDocument()
  })
  it('offers the same disabled default for a missing model field without silently saving or marking the form dirty', async () => {
    const { container, save } = open(stored({ enabled: false }))
    await screen.findByText('智能搜索未启用')
    expect(screen.getByRole('combobox', { name: '搜索模型包' })).toHaveValue('siglip2-base-full-int8')
    expect(screen.getByRole('option', { name: 'SigLIP2 Base 256 · 完整词表 INT8（当前未发现）' })).toBeInTheDocument()
    expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
    expect(save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ enabled: false, model: { package_id: 'siglip2-base-full-int8' } })
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
    expect(screen.getByText(/下方选择的是外挂存储上的派生索引目录，不会改变历史库的数据位置或连接/)).toBeInTheDocument()
    expect(screen.getByText(/容量满时自动淘汰最旧证据，按保留期清理；已有录像不会删除/)).toBeInTheDocument()
    expect(screen.queryByText(/清理最旧索引/)).not.toBeInTheDocument()
  })
  it('can save an enabled but pending model without pretending it is searchable', async () => {
    vi.mocked(searchService.models).mockResolvedValue({ items: [{ package_id: 'full-vocab-int8', display_name: '完整词表 INT8', ready: false, reason: 'model_pending', model_version: null, dimensions: 1152 }], service_ready: true, reason: null })
    const { save } = open(stored({ index_storage: { volume_id: 'ssd-uuid', relative_path: 'ainvr/search-index' } }))
    await screen.findByRole('option', { name: '完整词表 INT8 · 文件已发现' })
    fireEvent.change(screen.getByRole('combobox', { name: '搜索模型包' }), { target: { value: 'full-vocab-int8' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '启用智能搜索' }))
    expect(screen.getByText(/已发现所选模型包文件，运行是否就绪以上方实际状态为准/)).toBeInTheDocument()
    expect(screen.queryByText(/所选模型包尚未通过|当前不能搜索/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(save.mock.calls[0]![0][0].config).toMatchObject({ enabled: true, model: { package_id: 'full-vocab-int8' }, callers: [] })
    expect(screen.queryByText('模型与索引已就绪')).not.toBeInTheDocument()
  })
  it('keeps actual running readiness independent from metadata-only catalog flags', async () => {
    vi.mocked(searchService.models).mockResolvedValue({ items: [{ package_id: 'siglip2-base-full-int8', display_name: 'SigLIP2 Base 256', ready: false, reason: 'model_runtime_pending', model_version: null, dimensions: 768 }], service_ready: true, reason: null })
    vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: `search-v1-${'a'.repeat(64)}` })
    open(stored({ enabled: true, model: { package_id: 'siglip2-base-full-int8' } }))
    await screen.findByText('模型与索引已就绪')
    expect(screen.getByRole('option', { name: 'SigLIP2 Base 256 · 文件已发现' })).toBeInTheDocument()
    expect(screen.queryByText(/当前不能搜索|尚未通过就绪检查/)).not.toBeInTheDocument()
    expect(screen.queryByText(/本次修改尚未应用/)).not.toBeInTheDocument()
  })
  it('does not treat a different draft model as the active ready model', async () => {
    vi.mocked(searchService.models).mockResolvedValue({ items: [
      { package_id: 'siglip2-base-full-int8', display_name: 'SigLIP2 Base 256', ready: false, reason: 'model_runtime_pending', model_version: null, dimensions: 768 },
      { package_id: 'siglip-so400m-i18n-full-int8', display_name: 'SigLIP so400m', ready: false, reason: 'model_validation_pending', model_version: null, dimensions: 1152 },
    ], service_ready: true, reason: null })
    vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: `search-v1-${'a'.repeat(64)}` })
    const { save } = open(stored({ enabled: true, model: { package_id: 'siglip2-base-full-int8' } }))
    await screen.findByText('模型与索引已就绪')
    fireEvent.change(screen.getByRole('combobox', { name: '搜索模型包' }), { target: { value: 'siglip-so400m-i18n-full-int8' } })
    expect(screen.getByText('本次修改尚未应用；上方状态仍对应当前运行配置。')).toBeInTheDocument()
    expect(screen.getByText('模型与索引已就绪')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'SigLIP so400m · 文件已发现' })).toBeInTheDocument()
    expect(screen.queryByText(/SigLIP so400m.*已就绪|当前不能搜索|尚未通过就绪检查/)).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
  })
  it('does not infer service readiness from any catalog item readiness', async () => {
    vi.mocked(searchService.models).mockResolvedValue({ items: [{ package_id: 'siglip2-base-full-int8', display_name: 'SigLIP2 Base 256', ready: true, reason: null, model_version: `search-v1-${'a'.repeat(64)}`, dimensions: 768 }], service_ready: true, reason: null })
    vi.mocked(searchService.status).mockResolvedValue({ ready: false, reason: 'model_pending', model_version: null })
    open(stored({ enabled: true, model: { package_id: 'siglip2-base-full-int8' } }))
    await screen.findByText('模型或索引尚未就绪')
    expect(screen.queryByText('模型与索引已就绪')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'SigLIP2 Base 256 · 文件已发现' })).toBeInTheDocument()
  })
  it('does not describe a ready service as unavailable when only inventory loading fails', async () => {
    vi.mocked(searchService.models).mockRejectedValue(new Error('catalog offline'))
    vi.mocked(searchService.status).mockResolvedValue({ ready: true, reason: null, model_version: `search-v1-${'a'.repeat(64)}` })
    open(stored({ enabled: true, model: { package_id: 'siglip2-base-full-int8' } }))
    await screen.findByText('模型与索引已就绪')
    expect(screen.getByText('模型包列表暂不可用，已保存的选择会保留；服务运行状态以上方为准。')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '模型包（列表尚未确认）：siglip2-base-full-int8' })).toBeInTheDocument()
    expect(screen.queryByText(/搜索服务暂不可用|当前未发现|当前不能搜索/)).not.toBeInTheDocument()
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

it('explains skipped panorama sampling in all mode without changing or dirtying saved settings', async () => {
  vi.mocked(searchService.channels).mockResolvedValue({ items: [{ id: source, name: '全景后门', sampling_supported: false, sampling_reason: 'projection_unsupported' }] });
  const { container, save } = open(stored({ enabled: false, model: { package_id: null } }));
  await screen.findByText('1 个通道全景采集待验证，暂不新增采集；已有历史仍可查询。');
  expect(container.querySelector('[data-unsaved="true"]')).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
it('preserves selected panorama sources for removal while preventing new unsupported sampling selection', async () => {
  const normal = '00000000-0000-4000-8000-000000000002';
  vi.mocked(searchService.channels).mockResolvedValue({ items: [
    { id: source, name: '全景后门', sampling_supported: false, sampling_reason: 'projection_unsupported' },
    { id: normal, name: '普通大门', sampling_supported: true, sampling_reason: null },
  ] });
  const { save, container } = open(stored({ enabled: false, model: { package_id: null }, sampling: { mode: 'selected', channel_ids: [source, normal] } }));
  const panoramic = await screen.findByRole('checkbox', { name: /全景后门/ });
  expect(panoramic).toBeChecked(); expect(panoramic).not.toBeDisabled();
  expect(container.querySelector('[data-unsaved="true"]')).toBeNull();
  fireEvent.click(panoramic);
  expect(panoramic).not.toBeChecked(); expect(panoramic).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: '普通大门' })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0][0].config).toMatchObject({ sampling: { mode: 'selected', channel_ids: [normal] } });
});

it('shows measured usage independently from the draft and explains that retention is an upper bound', async () => {
  vi.mocked(searchCapacityService.read).mockResolvedValue({ samples: 100, bytes: 102400, max_samples: 100, max_bytes: 1024000, retention_days: 30, coverage: 12, max_coverage: 1000 });
  open();
  expect(await screen.findByText('100 / 100 条')).toBeInTheDocument();
  expect(screen.getByText(/是清理上限，不保证完整保存这些天/)).toBeInTheDocument();
  expect(screen.getByText(/已达到容量上限，新增采样可能暂停/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton', { name: '搜索保留时间（天）' }), { target: { value: '60' } });
  expect(screen.getByText(/当前运行保留上限为 30 天/)).toBeInTheDocument();
});
it('explains rolling retention instead of warning that sampling stops when the quota is full', async () => {
  vi.mocked(searchCapacityService.read).mockResolvedValue({ samples: 100, bytes: 1024000, max_samples: 100, max_bytes: 1024000, retention_days: 30,
    coverage: 12, max_coverage: 1000, evicted_samples: 250, evicted_bytes: 21500000, eviction_runs: 3, rolling_min_age_ms: 600000,
    oldest_retained_captured_ms: Date.parse('2026-10-29T10:00:00+08:00') });
  open();
  expect(await screen.findByText(/超出容量时自动淘汰最旧证据/)).toBeInTheDocument();
  expect(screen.getByText(/已淘汰 250 条/)).toBeInTheDocument();
  expect(screen.getByText(/最早保留证据/)).toBeInTheDocument();
  expect(screen.queryByText(/已达到容量上限，新增采样可能暂停/)).not.toBeInTheDocument();
});
it('keeps configuration editable when the administrator capacity service is unavailable', async () => {
  open();
  expect(await screen.findByText(/容量状态暂不可用，可继续编辑并保存配置/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '保存并应用' })).toBeEnabled();
});

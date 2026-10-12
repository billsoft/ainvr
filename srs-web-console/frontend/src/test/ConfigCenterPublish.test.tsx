import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const mocks = vi.hoisted(() => ({ apply: vi.fn(), status: vi.fn() }))
vi.mock('@/api/configService', () => ({ configService: {
  listDocuments: async () => [{ id: 1, service: 'backend', group: 'system', name: 'settings', updatedAt: '2026-10-07T01:00:00.000Z', config: { monitorSoftLimit: 6, monitorHardLimit: 9 } }],
  listServiceStates: async () => [], applyChanges: mocks.apply, getApplyOperation: mocks.status,
} }))
vi.mock('@/api/systemService', () => ({ systemService: { getSettings: async () => ({ adminPasswordSet: false }) } }))
vi.mock('@/store/settings', () => ({ useSettingsStore: { getState: () => ({ invalidate: async () => {} }) } }))
import ConfigCenter from '@/pages/ConfigCenter'
const job = (status = 'running') => ({ id: 'op1', status, stage: status === 'succeeded' ? '配置已保存并生效' : '等待服务应用', deadline: Date.now() + 480000 })
async function open() {
  render(<MemoryRouter><ConfigCenter /></MemoryRouter>)
  await screen.findByText('监看与轮询')
}
async function save() {
  fireEvent.change(screen.getByDisplayValue('6'), { target: { value: '5' } })
  fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
}
describe('自动保存应用', () => {
  it('rejects limits beyond the sixteen supported simultaneous views', async () => {
    await open()
    fireEvent.change(screen.getByDisplayValue('9'), { target: { value: '17' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并应用' }))
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('17')).toHaveAttribute('max', '16')
  })
  it('asks before discarding dirty category inputs and honors cancel', async () => {
    await open()
    fireEvent.change(screen.getByDisplayValue('6'), { target: { value: '5' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    try {
      fireEvent.click(screen.getByRole('button', { name: /AI微服务配置/ }))
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(screen.getByDisplayValue('5')).toBeInTheDocument()
      confirm.mockReturnValue(true)
      fireEvent.click(screen.getByRole('button', { name: /AI微服务配置/ }))
      expect(screen.getByLabelText('访问密钥', { exact: false })).toBeInTheDocument()
    } finally { confirm.mockRestore() }
  })
  beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue(null); mocks.apply.mockResolvedValue(job()) })
  afterEach(() => vi.useRealTimers())
  it('removes refresh/publish buttons and submits only changed category fields', async () => {
    await open()
    expect(screen.queryByRole('button', { name: '发布变更' })).toBeNull()
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()
    mocks.apply.mockResolvedValue(job('succeeded'))
    await save()
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith([{ service: 'backend', group: 'system', name: 'settings',
      config: { monitorSoftLimit: 5, monitorHardLimit: 9, pollIntervalMs: 5000 }, description: undefined, expectedUpdatedAt: '2026-10-07T01:00:00.000Z' }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('holds overlay until the server confirms success', async () => {
    await open(); vi.useFakeTimers()
    mocks.status.mockResolvedValue(job('succeeded'))
    await act(async () => { await save() })
    expect(screen.getByRole('dialog', { name: '配置更新中' })).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('unlocks and reports server timeout', async () => {
    await open(); vi.useFakeTimers()
    mocks.status.mockResolvedValue({ ...job('timeout'), stage: '更新超时，页面已解锁' })
    await act(async () => { await save(); await vi.advanceTimersByTimeAsync(1600) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByText('更新超时，页面已解锁').length).toBeGreaterThan(0)
  })
  it('unlocks after network failure instead of an endless spinner', async () => {
    await open(); mocks.apply.mockRejectedValue(new Error('网络请求超时'))
    await save()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getAllByText('网络请求超时').length).toBeGreaterThan(0)
  })
  it('resumes server progress on re-entering page', async () => {
    mocks.status.mockResolvedValue(job())
    render(<MemoryRouter><ConfigCenter /></MemoryRouter>)
    expect(await screen.findByRole('dialog', { name: '配置更新中' })).toBeInTheDocument()
  })
})

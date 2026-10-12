import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ActivateForm } from '@/pages/License/ActivateForm'
import { LicenseStatusCard } from '@/pages/License/LicenseStatusCard'
import { LicenseGateOverlay } from '@/components/layout/LicenseGateOverlay'
import { licenseService } from '@/api/licenseService'
import { useLicenseStore } from '@/store/license'
import type { LicenseStatus } from '@/types/license'

vi.mock('@/api/licenseService', async (load) => {
  const actual = await load<typeof import('@/api/licenseService')>()
  return { ...actual, licenseService: { getStatus: vi.fn(), getMachineCode: vi.fn(), preview: vi.fn(), activate: vi.fn() } }
})
const status: LicenseStatus = { state: 'valid', mode: 'hybrid_local', machine_code: 'code',
  soc_model: 'Jetson', remaining_minutes: 1, remaining_seconds: 59, expires_min: 1,
  seq: 2, reason: '', service_ok: true, enforcer_tripped: false }
beforeEach(() => {
  vi.clearAllMocks()
  useLicenseStore.setState({ status: null, statusLoading: false, activating: false, gateBlock: null, events: [] })
})
describe('license recovery UI', () => {
  it('imports a file without activating or previewing automatically', async () => {
    render(<ActivateForm />)
    const file = new File(['AINVR-LIC3-abc.def'], 'license.lic', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: async () => 'AINVR-LIC3-abc.def\r\n' })
    fireEvent.change(screen.getByLabelText('选择注册码文件'), { target: { files: [file] } })
    await waitFor(() => expect(screen.getByLabelText('注册码')).toHaveValue('AINVR-LIC3-abc.def'))
    expect(licenseService.activate).not.toHaveBeenCalled()
    expect(licenseService.preview).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '核对注册码' })).toBeEnabled()
  })
  it('does not clear a business block from authority status alone', async () => {
    useLicenseStore.setState({ gateBlock: { code: 'LICENSE_SERVICE_UNAVAILABLE', at: 1 } })
    vi.mocked(licenseService.getStatus).mockResolvedValue({ ...status, business_allowed: false })
    await useLicenseStore.getState().refreshStatus(true)
    expect(useLicenseStore.getState().gateBlock).not.toBeNull()
    vi.mocked(licenseService.getStatus).mockResolvedValue({ ...status, business_allowed: true })
    await useLicenseStore.getState().refreshStatus(true)
    expect(useLicenseStore.getState().gateBlock).toBeNull()
  })

  it('previews replacement before consuming a registration key', async () => {
    vi.mocked(licenseService.preview).mockResolvedValue({ license_id: 'a', grant_seq: 2, duration_minutes: 120, policy: 'hybrid_local', operation: 'replace', current_remaining_seconds: 60 })
    vi.mocked(licenseService.activate).mockResolvedValue({ ...status, activation_result: 'activated' })
    render(<ActivateForm />)
    fireEvent.change(screen.getByLabelText('注册码'), { target: { value: 'AINVR-LIC-example' } })
    fireEvent.click(screen.getByRole('button', { name: '核对注册码' }))
    await screen.findByRole('button', { name: '确认激活授权' })
    expect(licenseService.activate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认激活授权' }))
    await screen.findByText(/授权已保存/)
    expect(licenseService.activate).toHaveBeenCalledTimes(1)
  })
  it('always retains a management entry during service outage', () => {
    useLicenseStore.setState({ gateBlock: { code: 'LICENSE_SERVICE_UNAVAILABLE', at: 1 } })
    render(<MemoryRouter initialEntries={['/monitor']}><LicenseGateOverlay /></MemoryRouter>)
    expect(screen.getByRole('link', { name: '前往授权管理与诊断' })).toHaveAttribute('href', '/config-center?category=license')
  })
  it('系统时间无效导致的暂停：说明原因并直接引导去校准时间', () => {
    useLicenseStore.setState({ gateBlock: { code: 'LICENSE_REQUIRED', at: 1, state: 'clock_error', reason: 'SYSTEM_TIME_INVALID' } })
    render(<MemoryRouter initialEntries={['/monitor']}><LicenseGateOverlay /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: '设备时间无效' })).toBeInTheDocument()
    expect(screen.getByText(/校准系统时间后自动恢复/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往校准系统时间' })).toHaveAttribute('href', '/config-center?category=time')
  })
  it('shows true remaining seconds rather than multiplying truncated minutes', () => {
    render(<LicenseStatusCard status={status} statusAt={performance.now()} loading={false} unreachable={false} />)
    expect(screen.getByText('00:00:59')).toBeInTheDocument()
  })
  it('does not claim live availability from an offline cached status', () => {
    render(<LicenseStatusCard status={status} statusAt={performance.now()} loading={false} unreachable />)
    expect(screen.getByText(/下方为上次状态/)).toBeInTheDocument()
    expect(screen.queryByText('00:00:59')).toBeNull()
  })
  it('a pre-activation response cannot overwrite the activation result', async () => {
    let resolve!: (value: LicenseStatus) => void
    vi.mocked(licenseService.getStatus).mockReturnValue(new Promise((r) => { resolve = r }))
    vi.mocked(licenseService.activate).mockResolvedValue({ ...status, seq: 8 })
    const pending = useLicenseStore.getState().refreshStatus(true)
    await useLicenseStore.getState().activate('key')
    resolve({ ...status, seq: 1, state: 'expired' })
    await pending
    await waitFor(() => expect(useLicenseStore.getState().status?.seq).toBe(8))
  })
})

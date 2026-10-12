import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MachineCodeCard } from '@/pages/License/MachineCodeCard'
import { downloadRequest } from '@/pages/License/licenseFiles'

vi.mock('@/pages/License/licenseFiles', () => ({ downloadRequest: vi.fn() }))

describe('signed license request', () => {
  it('keeps the short machine code and exposes the full installation request', () => {
    render(<MachineCodeCard loading={false} unreachable={false} onRefresh={vi.fn()}
      machineCode={{ machine_code: 'TEST-MACHINE', soc_model: 'Jetson', fingerprint_version: 'v2',
        activation_request: 'AINVR-REQ3-current-installation', request_kind: 'activate' }} />)
    expect(screen.getByText('TEST-MACHINE')).toBeInTheDocument()
    expect(screen.getByLabelText('完整授权申请')).toHaveValue('AINVR-REQ3-current-installation')
    fireEvent.click(screen.getByRole('button', { name: '下载申请文件' }))
    expect(downloadRequest).toHaveBeenCalledWith('AINVR-REQ3-current-installation', 'TEST-MACHINE')
  })
  it('explains recovery without promising a fresh duration', () => {
    render(<MachineCodeCard loading={false} unreachable={false} onRefresh={vi.fn()}
      machineCode={{ machine_code: 'TEST-MACHINE', soc_model: 'Jetson', fingerprint_version: 'v2',
        activation_request: 'AINVR-REQ3-fresh-challenge', request_kind: 'recover' }} />)
    expect(screen.getByText('恢复授权申请')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('旧注册码不能重新计时')
  })
})

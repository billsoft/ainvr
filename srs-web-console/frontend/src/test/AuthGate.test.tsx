import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AuthGate } from '@/components/auth/AuthGate'
import { useAuthStore } from '@/store/auth'
import { request } from '@/api/httpClient'

vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
vi.mock('@/store/branding', () => ({ useBranding: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  useAuthStore.setState({ required: true, setupRequired: true, token: null,
    checkStatus: vi.fn().mockResolvedValue(undefined), login: vi.fn().mockResolvedValue(true) })
})

it('does not submit mismatched bootstrap passwords', async () => {
  render(<AuthGate><div>private page</div></AuthGate>)
  fireEvent.change(screen.getByLabelText('管理密码', { exact: true }), { target: { value: 'password-one' } })
  fireEvent.change(screen.getByLabelText('确认管理密码'), { target: { value: 'password-two' } })
  fireEvent.click(screen.getByRole('button', { name: '设置并进入' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('两次输入的密码不一致')
  await waitFor(() => expect(screen.getByRole('button', { name: '设置并进入' })).not.toBeDisabled())
  expect(request).not.toHaveBeenCalled()
  expect(screen.queryByText('private page')).not.toBeInTheDocument()
})

it('saves the initial password before logging in and refreshes setup state', async () => {
  vi.mocked(request).mockResolvedValue({ code: 0 })
  render(<AuthGate><div>private page</div></AuthGate>)
  fireEvent.change(screen.getByLabelText('管理密码', { exact: true }), { target: { value: 'test-password' } })
  fireEvent.change(screen.getByLabelText('确认管理密码'), { target: { value: 'test-password' } })
  fireEvent.click(screen.getByRole('button', { name: '设置并进入' }))
  await waitFor(() => expect(useAuthStore.getState().login).toHaveBeenCalledWith('test-password', true))
  expect(request).toHaveBeenCalledWith('/settings/password', {
    method: 'PUT', body: JSON.stringify({ password: 'test-password' }),
  })
  expect(useAuthStore.getState().checkStatus).toHaveBeenCalledTimes(2)
})

it('shows short-password feedback without a page-level toaster', async () => {
  render(<AuthGate><div>private page</div></AuthGate>)
  fireEvent.change(screen.getByLabelText('管理密码', { exact: true }), { target: { value: 'short' } })
  fireEvent.click(screen.getByRole('button', { name: '设置并进入' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('管理密码至少需要 8 个字符')
  expect(request).not.toHaveBeenCalled()
})

it('shows a save failure inline and permits retry', async () => {
  vi.mocked(request).mockRejectedValueOnce(new Error('配置服务暂时不可用'))
  render(<AuthGate><div>private page</div></AuthGate>)
  for (const label of ['管理密码', '确认管理密码']) {
    fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value: 'test-password' } })
  }
  fireEvent.click(screen.getByRole('button', { name: '设置并进入' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('配置服务暂时不可用')
  expect(useAuthStore.getState().login).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '设置并进入' })).not.toBeDisabled()
  vi.mocked(request).mockResolvedValueOnce({ code: 0 })
  fireEvent.click(screen.getByRole('button', { name: '设置并进入' }))
  await waitFor(() => expect(useAuthStore.getState().login).toHaveBeenCalledWith('test-password', true))
})

it('shows login failures inline without exposing the private page', async () => {
  useAuthStore.setState({ setupRequired: false, login: vi.fn().mockResolvedValue(false) })
  render(<AuthGate><div>private page</div></AuthGate>)
  fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'incorrect-password' } })
  fireEvent.click(screen.getByRole('button', { name: '进入' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('登录失败')
  expect(screen.queryByText('private page')).not.toBeInTheDocument()
})

it('remembers this device by default and lets the user opt out', async () => {
  useAuthStore.setState({ setupRequired: false })
  render(<AuthGate><div>private page</div></AuthGate>)
  const remember = screen.getByLabelText('记住此设备（30 天内免登录）')
  expect(remember).toBeChecked()
  fireEvent.change(screen.getByLabelText('访问密码'), { target: { value: 'secret-pass' } })
  fireEvent.click(remember)
  fireEvent.click(screen.getByRole('button', { name: '进入' }))
  await waitFor(() => expect(useAuthStore.getState().login).toHaveBeenCalledWith('secret-pass', false))
})
it('sends the remember choice with the login request', async () => {
  vi.resetModules()  // a fresh store instance, not the one stubbed in beforeEach
  const { useAuthStore: fresh } = await import('@/store/auth')
  const { request: freshRequest } = await import('@/api/httpClient')
  vi.mocked(freshRequest).mockResolvedValue({ code: 0, data: { token: 't' } })
  await fresh.getState().login('secret-pass', true)
  expect(freshRequest).toHaveBeenCalledWith('/auth/login', { method: 'POST', body: JSON.stringify({ password: 'secret-pass', remember: true }) })
})

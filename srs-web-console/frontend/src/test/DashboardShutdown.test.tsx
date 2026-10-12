import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import Dashboard from '@/pages/Dashboard'
import { observabilityService } from '@/api/observabilityService'

vi.mock('@/api/observabilityService', () => ({ observabilityService: {
  summary: vi.fn(async () => ({})), history: vi.fn(async () => ({ items: [] })),
  shutdown: vi.fn(async () => ({ stepsCompleted: 0 })), shutdownStatus: vi.fn(),
} }))

const statusMock = vi.mocked(observabilityService.shutdownStatus)

async function startShutdown() {
  render(<MemoryRouter><Dashboard /></MemoryRouter>)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: /安全关机/ }))
  fireEvent.change(screen.getByPlaceholderText('请输入“关机”以确认'), { target: { value: '关机' } })
  fireEvent.click(screen.getByRole('button', { name: '确认关机' }))
  await act(async () => {})
}

describe('安全关机：中途失败要让人看见，不能一直显示"正在关机"', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('关机序列失败：显示原因与已恢复的服务，可以关闭弹窗', async () => {
    vi.useFakeTimers()
    try {
      statusMock.mockResolvedValue({ state: 'failed', error: '第 2 步「停止 AI 识别服务」超时（>95s）；关机已中止，已恢复：AI 识别服务、录像服务', restored: ['AI 识别服务', '录像服务'], restoreFailed: [] })
      await startShutdown()
      expect(screen.getByText('正在安全关机')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByText(/关机未完成/)).toBeInTheDocument()
      expect(screen.getByText(/已恢复：AI 识别服务、录像服务/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '取消' })).not.toBeDisabled()
    } finally { vi.useRealTimers() }
  })

  it('状态查询失败（设备正在断电，页面连不上）：保持"正在关机"', async () => {
    vi.useFakeTimers()
    try {
      statusMock.mockRejectedValue(new Error('Failed to fetch'))
      await startShutdown()
      for (let i = 0; i < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByText('正在安全关机')).toBeInTheDocument()
      expect(screen.queryByText(/关机未完成/)).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('正在执行或即将断电：保持"正在关机"', async () => {
    vi.useFakeTimers()
    try {
      statusMock.mockResolvedValue({ state: 'running', error: '', restored: [], restoreFailed: [] })
      await startShutdown()
      await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
      expect(screen.getByText('正在安全关机')).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })
})

import { act, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import Dashboard from '@/pages/Dashboard'
import { observabilityService, type Snapshot } from '@/api/observabilityService'

vi.mock('@/api/observabilityService', () => ({ observabilityService: {
  summary: vi.fn(), history: vi.fn(),
} }))

function sample(ts: number, bpuPercent?: number | null): Snapshot {
  return { ts, sampleSeconds: 10, services: [], host: {
    cpuPercent: 10, memoryBytes: 1024, memoryTotalBytes: 2048,
    cores: 6, swapBytes: 0, gpuPercent: 99, bpuPercent,
  } }
}

describe('S100P dashboard BPU data', () => {
  it.each([28, 0, null, undefined])('shows BPU %s without borrowing GPU history', async value => {
    const now = Date.now()
    const current = sample(now, value)
    vi.mocked(observabilityService.summary).mockResolvedValue({
      snapshot: current, sources: [], applyError: null,
      settings: { fileMiB: 5, files: 3, historyHours: 72, level: 'INFO', repeatSeconds: 60 },
    })
    vi.mocked(observabilityService.history).mockResolvedValue({
      items: [sample(now - 10000), current],
    })
    const { unmount } = render(<MemoryRouter><Dashboard /></MemoryRouter>)
    try {
      await act(async () => {})
      const label = screen.getByText('BPU · 神经网络利用率')
      const card = label.closest('.rounded-xl') as HTMLElement
      expect(within(card).getByText(value == null ? '—' : `${value.toFixed(1)}%`)).toBeInTheDocument()
      expect(within(card).queryByText('99.0%')).toBeNull()
      expect(screen.getByText('整机 BPU 利用率')).toBeInTheDocument()
      expect(screen.queryByText('主机共享 GPU')).toBeNull()
      expect(document.body.textContent).not.toContain('NaN')
    } finally { unmount() }
  })
})

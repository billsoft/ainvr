import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { it, expect, vi, beforeEach } from 'vitest'
import { Topbar } from '@/components/layout/Topbar'
import { observabilityService } from '@/api/observabilityService'

vi.mock('@/api/brandingService', () => ({ brandingService: { get: vi.fn().mockResolvedValue(null) } }))
vi.mock('@/components/layout/AlarmPendingIndicator', () => ({ AlarmPendingIndicator: () => null }))
vi.mock('@/components/layout/RemoteAssistIndicator', () => ({ RemoteAssistIndicator: () => null }))
vi.mock('@/api/observabilityService', () => ({ observabilityService: { summary: vi.fn(), streamHealth: vi.fn() } }))

const healthySummary = () => ({ snapshot: { ts: Date.now(), sampleSeconds: 5, host: { cpuPercent: 1, memoryBytes: 1, memoryTotalBytes: 2, gpuPercent: null, cores: 6, swapBytes: 0 },
  services: [{ id: 'ai', state: 'active', healthy: true, cpuPercent: 1, memoryBytes: 1, connections: null }] }, settings: {} as never, sources: [], applyError: null })

beforeEach(() => {
  vi.mocked(observabilityService.summary).mockResolvedValue(healthySummary())
})

it('services all up but a channel interrupted: the bar says so instead of “all OK”', async () => {
  vi.mocked(observabilityService.streamHealth).mockResolvedValue({ known: true, checkedAt: Date.now(), problems: [
    { kind: 'ai', id: 'a', name: '公司过道', since: Date.now() - 600000, detail: '识别中断，正在反复重连' },
    { kind: 'recording', id: 'r', name: '大话gb28181_ai', since: Date.now() - 600000, detail: '录像中断：等待源流' },
  ] })
  render(<MemoryRouter><Topbar /></MemoryRouter>)
  const status = await screen.findByText('2 路中断')
  expect(status.closest('a')).toHaveAttribute('title', expect.stringContaining('公司过道'))
  expect(status.closest('a')).toHaveAttribute('title', expect.stringContaining('10 分'))
  expect(screen.getByText('1/1 服务正常').closest('a')).toHaveAttribute('href','/dashboard')
  expect(status.closest('a')).toHaveAttribute('href','/channels')
})

it('no interruptions keeps the normal service summary', async () => {
  vi.mocked(observabilityService.streamHealth).mockResolvedValue({ known: true, checkedAt: Date.now(), problems: [] })
  render(<MemoryRouter><Topbar /></MemoryRouter>)
  expect(await screen.findByText('1/1 服务正常')).toBeInTheDocument()
})

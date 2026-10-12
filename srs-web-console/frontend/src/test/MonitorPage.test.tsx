import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { mockChannels } from '@/mock/channels'
import { useMonitorStore } from '@/store/monitor'
import MonitorPage from '@/pages/Monitor'

vi.mock('@/components/player/VideoPlayer', () => ({ VideoPlayer: () => <div data-testid="vp" /> }))
vi.mock('@/pages/Monitor/useMonitorCatalog', () => ({ useMonitorCatalog: () => ({
  allChannels: mockChannels, outputIds: new Map(), variants: new Map(), ready: true, error: '',
}) }))
const settings = { monitorHardLimit: 2, monitorSoftLimit: 2 }
const fetchSettings = vi.fn()
vi.mock('@/store/settings', () => ({ useSettingsStore: () => ({ settings, fetchSettings }) }))

beforeEach(() => {
  useMonitorStore.setState({ layout: '2x2', mode: 'auto', page: 0, slots: [null, null, null, null], selectedOutputs: {}, initialized: false, focusedChannelId: null })
})
const renderPage = () => render(<MemoryRouter><MonitorPage /></MemoryRouter>)

describe('MonitorPage stable layout', () => {
  it('retains the source selector when a saved AI output is unavailable', async () => {
    const user = userEvent.setup()
    const source = mockChannels[0]!
    useMonitorStore.setState({ slots: [source.id, null, null, null], initialized: true, selectedOutputs: { [source.id]: 'removed-ai-output' } })
    renderPage()
    const selector = screen.getByLabelText(`播放来源 ${source.name}`)
    expect(selector).toHaveValue('removed-ai-output')
    expect(screen.queryByTestId('vp')).not.toBeInTheDocument()
    await user.selectOptions(selector, source.id)
    expect(useMonitorStore.getState().selectedOutputs[source.id]).toBe(source.id)
  })
  it('keeps service order and caps mounted players', async () => {
    renderPage()
    await waitFor(() => expect(useMonitorStore.getState().initialized).toBe(true))
    const items = screen.getAllByTestId(/^monitor-item-/)
    expect(items.map(i => i.getAttribute('data-testid'))).toEqual(mockChannels.map(c => `monitor-item-${c.id}`))
    expect(screen.getAllByTestId('vp').length).toBeLessThanOrEqual(2)
  })
  it('selecting a smaller layout preserves all arranged channels', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(useMonitorStore.getState().initialized).toBe(true))
    await user.selectOptions(screen.getByLabelText('监看布局'), '1x1')
    expect(useMonitorStore.getState().slots.filter(Boolean)).toHaveLength(mockChannels.length)
    expect(screen.getByLabelText('下一页')).toBeEnabled()
    await user.click(screen.getByLabelText('下一页'))
    expect(useMonitorStore.getState().page).toBe(1)
  })
  it('focus unmounts grid and returning restores it', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('slot-focus-0'))
    expect(screen.queryByTestId('monitor-grid')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('focus-back'))
    expect(screen.getByTestId('monitor-grid')).toBeInTheDocument()
  })
})

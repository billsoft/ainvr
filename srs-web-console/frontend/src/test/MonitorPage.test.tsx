import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { mockChannels } from '@/mock/channels'
import { useMonitorStore } from '@/store/monitor'
import MonitorPage from '@/pages/Monitor'

vi.mock('@/components/player/VideoPlayer', () => ({ VideoPlayer: (props:{onArming?:(video:HTMLVideoElement)=>void;savedZoneSource?:{id:string;createdAt?:string;inputGeneration?:string}}) => <div data-testid="vp" data-zone-source={JSON.stringify(props.savedZoneSource)}>{props.onArming&&<button onClick={()=>props.onArming!(document.createElement('video'))}>布防</button>}</div> }))
vi.mock('@/pages/AlarmCenter/ArmingLauncher',()=>({ArmingLauncher:({onClose}:{onClose:()=>void})=><div role="dialog" aria-label="布防"><button onClick={onClose}>取消布防</button></div>}))
vi.mock('@/pages/Monitor/useMonitorCatalog', () => ({ useMonitorCatalog: () => ({
  allChannels: mockChannels, outputIds: new Map([[`${mockChannels[1]!.upstream.app}/${mockChannels[1]!.upstream.stream}`,"processor-one"]]), variants: new Map([[mockChannels[0]!.id,[mockChannels[1]!]]]), gbBindings: [], ready: true, error: '',
}) }))
const settings = { monitorHardLimit: 2, monitorSoftLimit: 2 }
const fetchSettings = vi.fn()
vi.mock('@/store/settings', () => ({ useSettingsStore: () => ({ settings, fetchSettings }) }))

beforeEach(() => {
  mockChannels[1]!.status.online=true;
  useMonitorStore.setState({ layout: '2x2', mode: 'auto', page: 0, slots: [null, null, null, null], selectedOutputs: {}, initialized: false, focusedChannelId: null })
})
const renderPage = () => render(<MemoryRouter><MonitorPage /></MemoryRouter>)

it('shows the original camera and ingest protocol for an AI output in grid and focus', async () => {
  const user = userEvent.setup()
  renderPage()
  const label = `原始输入：${mockChannels[0]!.name}；接入协议：RTMP；视频流：live/cam_main_door`
  await waitFor(() => expect(screen.getAllByLabelText(label)).toHaveLength(2))
  await user.click(screen.getByTestId('slot-focus-1'))
  expect(screen.getByLabelText(label)).toHaveTextContent(`来源：${mockChannels[0]!.name}`)
  expect(screen.getByLabelText(label)).toHaveTextContent('RTMP')
})

it('updates the source label when the selected playback switches to AI output', async () => {
  const user = userEvent.setup()
  renderPage()
  await user.selectOptions(screen.getByLabelText(`播放来源 ${mockChannels[0]!.name}`), mockChannels[1]!.id)
  expect(screen.getAllByText(`来源：${mockChannels[0]!.name}`)).toHaveLength(2)
})

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
    await user.click(screen.getByRole('button', { name: '4 宫格' }))
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

it('focused AI output forwards its stable generation or creation identity to the saved zone overlay',async()=>{
 const user=userEvent.setup();renderPage();await user.click(await screen.findByTestId('slot-focus-1'))
 const value=JSON.parse(screen.getByTestId('vp').getAttribute('data-zone-source')!)
 expect(value.processorId).toBe('processor-one');expect(value.id).toBe(mockChannels[0]!.id);expect(value.createdAt).toBe(mockChannels[0]!.createdAt)
 expect(value.inputGeneration||value.createdAt).toBeTruthy()
})

it('arming opens over the focused player without replacing its playback element',async()=>{
 const user=userEvent.setup();renderPage();await user.click(await screen.findByTestId('slot-focus-1'))
 const player=screen.getByTestId('vp')
 await user.click(screen.getByRole('button',{name:'布防'}))
 expect(screen.getByRole('dialog',{name:'布防'})).toBeInTheDocument()
 expect(screen.getByTestId('vp')).toBe(player)
 await user.click(screen.getByRole('button',{name:'取消布防'}))
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(screen.getByTestId('vp')).toBe(player)
})

it('restores every channel in catalogue order after clearing and keeps the chosen capacity', async () => {
  const user = userEvent.setup(); renderPage()
  await user.click(screen.getByRole('button', {name: '32 宫格'}))
  expect(screen.getByRole('button', {name: '32 宫格'})).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('combobox', {name: '监看布局'})).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', {name: '清空监看'}))
  expect(useMonitorStore.getState().slots.filter(Boolean)).toHaveLength(0)
  await user.click(screen.getByRole('button', {name: '恢复通道顺序'}))
  expect(useMonitorStore.getState().slots.filter(Boolean)).toEqual(mockChannels.map(c => c.id))
  expect(useMonitorStore.getState().layout).toBe('8x4')
  expect(useMonitorStore.getState().page).toBe(0)
  expect(screen.getAllByTestId('vp').length).toBeLessThanOrEqual(2)
})

it('raw input has neither arming action nor saved-zone overlay',async()=>{
 const user=userEvent.setup();renderPage();await user.click(await screen.findByTestId('slot-focus-0'))
 expect(screen.getByTestId('vp')).not.toHaveAttribute('data-zone-source')
 expect(screen.queryByRole('button',{name:'布防'})).not.toBeInTheDocument()
})

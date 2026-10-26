import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { OnvifSourceFields } from '@/pages/Channels/OnvifSourceFields'
import { onvifService } from '@/api/onvifService'
vi.mock('@/api/onvifService', () => ({
  onvifService: { devices: vi.fn(), device: vi.fn(), settings: vi.fn(), probe: vi.fn() },
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const profile = {
  service: 'media2' as const,
  token: 'main',
  name: 'Main',
  videoSource: 'source-a',
  videoCodec: 'H264',
  audioCodec: 'AAC',
  width: 1920,
  height: 1080,
  fps: 10,
}
const binding = {
  deviceId: 'device-a',
  deviceVersion: 1,
  service: 'media2' as const,
  profileToken: 'main',
  videoSource: 'source-a',
}
describe('ONVIF source choice', () => {
  it('requires a physical source and explicit profile rather than selecting an arbitrary NVR picture', async () => {
    vi.mocked(onvifService.devices).mockResolvedValue({
      items: [
        {
          id: 'device-a',
          name: 'NVR',
          url: 'http://camera/device',
          username: 'operator',
          version: 1,
          certificateSHA256: '',
          credentialSet: true,
          capabilities: {
            manufacturer: 'Test',
            model: 'NVR',
            firmware: '1',
            serial: 's',
            clockVerified: true,
            clockOffsetSeconds: 0,
            profiles: [profile, { ...profile, token: 'other', videoSource: 'source-b' }],
            warnings: [],
          },
        },
      ],
    })
    vi.mocked(onvifService.device).mockImplementation(
      async (id) => (await onvifService.devices()).items.find((d) => d.id === id)!,
    )
    vi.mocked(onvifService.settings).mockResolvedValue({
      revision: 1,
      tokenSet: true,
      settings: {
        enabled: true,
        serviceUrl: 'http://127.0.0.1:8150',
        allowedCIDRs: ['192.0.2.0/24'],
        interfaces: [],
        timeoutSeconds: 3,
      },
    })
    const draft = vi.fn()
    render(
      <MemoryRouter>
        <OnvifSourceFields onDraft={draft} onDirty={() => {}} onBusy={() => {}} />
      </MemoryRouter>,
    )
    await screen.findByRole('option', { name: /NVR/ })
    fireEvent.change(screen.getByLabelText('ONVIF 设备'), { target: { value: 'device-a' } })
    await waitFor(() => expect(screen.getByLabelText('ONVIF 视频源')).toBeTruthy())
    expect(draft).toHaveBeenLastCalledWith(null)
    fireEvent.change(screen.getByLabelText('ONVIF 视频源'), { target: { value: 'source-a' } })
    fireEvent.change(screen.getByLabelText('ONVIF 码流'), { target: { value: 'media2:main' } })
    await waitFor(() => expect(draft).toHaveBeenLastCalledWith(binding))
  })
  it('shows a missing original profile and leaves the binding invalid', async () => {
    vi.mocked(onvifService.devices).mockResolvedValue({
      items: [
        {
          id: 'device-a',
          name: 'NVR',
          url: 'http://camera/device',
          username: 'operator',
          version: 1,
          certificateSHA256: '',
          credentialSet: true,
          capabilities: {
            manufacturer: 'Test',
            model: 'NVR',
            firmware: '1',
            serial: 's',
            clockVerified: true,
            clockOffsetSeconds: 0,
            profiles: [{ ...profile, token: 'replacement' }],
            warnings: [],
          },
        },
      ],
    })
    vi.mocked(onvifService.device).mockImplementation(
      async (id) => (await onvifService.devices()).items.find((d) => d.id === id)!,
    )
    vi.mocked(onvifService.settings).mockResolvedValue({
      revision: 1,
      tokenSet: true,
      settings: {
        enabled: true,
        serviceUrl: 'http://127.0.0.1:8150',
        allowedCIDRs: ['192.0.2.0/24'],
        interfaces: [],
        timeoutSeconds: 3,
      },
    })
    const draft = vi.fn()
    render(
      <MemoryRouter>
        <OnvifSourceFields initial={binding} onDraft={draft} onDirty={() => {}} onBusy={() => {}} />
      </MemoryRouter>,
    )
    await screen.findByText(/原码流未出现在当前列表/)
    expect(draft).toHaveBeenLastCalledWith(null)
  })
})

it('keeps the selected device and physical source visible when searching a large installation', async () => {
  const profiles = [
    profile,
    ...Array.from({ length: 9 }, (_, i) => ({
      ...profile,
      token: 'p' + i,
      videoSource: 'source-' + i,
      name: 'Camera ' + i,
    })),
  ]
  const capabilities = {
    manufacturer: 'Fixture',
    model: 'NVR',
    firmware: '1',
    serial: 'test',
    clockVerified: true,
    clockOffsetSeconds: 0,
    profiles,
    warnings: [],
  }
  const devices = Array.from({ length: 10 }, (_, i) => ({
    id: i === 0 ? 'device-a' : 'device-' + i,
    name: 'NVR ' + i,
    url: 'http://camera' + i + '/device',
    username: 'operator',
    version: 1,
    certificateSHA256: '',
    credentialSet: true,
  }))
  vi.mocked(onvifService.devices).mockResolvedValue({ items: devices })
  vi.mocked(onvifService.device).mockResolvedValue({ ...devices[0]!, capabilities })
  vi.mocked(onvifService.settings).mockResolvedValue({
    revision: 1,
    tokenSet: true,
    settings: {
      enabled: true,
      serviceUrl: 'http://127.0.0.1:8150',
      allowedCIDRs: ['192.0.2.0/24'],
      interfaces: [],
      timeoutSeconds: 3,
    },
  })
  const draft = vi.fn()
  render(
    <MemoryRouter>
      <OnvifSourceFields initial={binding} onDraft={draft} onDirty={() => {}} onBusy={() => {}} />
    </MemoryRouter>,
  )
  await waitFor(() => expect(draft).toHaveBeenLastCalledWith(binding))
  fireEvent.change(screen.getByPlaceholderText('设备名称、型号或地址'), {
    target: { value: 'not-a-match' },
  })
  fireEvent.change(screen.getByPlaceholderText('视频源标识或码流名称'), {
    target: { value: 'Camera 8' },
  })
  expect((screen.getByLabelText('ONVIF 设备') as HTMLSelectElement).value).toBe('device-a')
  expect((screen.getByLabelText('ONVIF 视频源') as HTMLSelectElement).value).toBe('source-a')
  expect(draft).toHaveBeenLastCalledWith(binding)
})

it('keeps the catalogue usable when the original restored device no longer exists',async()=>{
 const device={id:'replacement',name:'Replacement NVR',url:'http://replacement/device',username:'operator',version:1,certificateSHA256:'',credentialSet:true};
 vi.mocked(onvifService.devices).mockResolvedValue({items:[device]});
 vi.mocked(onvifService.device).mockImplementation(async(id)=>{if(id==='device-a')throw new Error('原设备不存在');return {...device,capabilities:{manufacturer:'Test',model:'NVR',firmware:'1',serial:'s',clockVerified:true,clockOffsetSeconds:0,profiles:[profile],warnings:[]}}});
 vi.mocked(onvifService.settings).mockResolvedValue({revision:1,tokenSet:true,settings:{enabled:true,serviceUrl:'http://127.0.0.1:8150',allowedCIDRs:['192.0.2.0/24'],interfaces:[],timeoutSeconds:3}});
 const draft=vi.fn();render(<MemoryRouter><OnvifSourceFields initial={binding} onDraft={draft} onDirty={()=>{}} onBusy={()=>{}} /></MemoryRouter>);
 await screen.findByRole('option',{name:/Replacement NVR/});
 expect(draft).toHaveBeenLastCalledWith(null);
 fireEvent.change(screen.getByLabelText('ONVIF 设备'),{target:{value:'replacement'}});
 await waitFor(()=>expect(screen.getByLabelText('ONVIF 视频源')).toBeTruthy());
 fireEvent.change(screen.getByLabelText('ONVIF 视频源'),{target:{value:'source-a'}});
 fireEvent.change(screen.getByLabelText('ONVIF 码流'),{target:{value:'media2:main'}});
 await waitFor(()=>expect(draft).toHaveBeenLastCalledWith({...binding,deviceId:'replacement'}));
});

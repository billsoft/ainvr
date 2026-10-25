import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
import {GBSourceFields} from '@/pages/Channels/GBSourceFields'
import {mockChannels} from '@/mock/channels'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
const device='34020000001320000001',channel='34020000001320000002'
let mapped=false
beforeEach(()=>{mapped=false;vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
 if(options?.method)return {revision:8} as never
 const items=[{id:channel,document:{name:'门口画面'},available:true,enabled:false,transport:'tcp-passive',...(mapped?{input_id:mockChannels[0]!.id}:{})}]
 if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:[{id:device,name:'门口设备',version:'2016',enabled:true}],items:path.includes('?')?items:[]} as never
 if(path.endsWith('/channels'))return {items} as never
 return {state:'disabled',devices:[],inputs:[]} as never
})})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
async function choose(){
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'自定义入口'}})
 fireEvent.click(screen.getByRole('button',{name:'GB/T 28181 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
 await screen.findByRole('option',{name:`门口设备 · ${device}`})
 fireEvent.change(screen.getByLabelText('国标设备'),{target:{value:device}})
 fireEvent.click(await screen.findByRole('radio'))
}
it('saves metadata, playback and source once at the end of the common wizard',async()=>{
 const saved=vi.fn(),submit=vi.fn()
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={submit} onGBSaved={saved}/></MemoryRouter>)
 await choose()
 fireEvent.change(screen.getByLabelText('媒体传输方式'),{target:{value:'udp'}})
 expect(vi.mocked(request).mock.calls.some(([,o])=>o?.method==='POST')).toBe(false)
 fireEvent.click(screen.getByTestId('wizard-next'))
 fireEvent.change(screen.getByTestId('wizard-primary'),{target:{value:'hls'}})
 fireEvent.click(screen.getByTestId('wizard-submit'))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 expect(submit).not.toHaveBeenCalled()
 const body=JSON.parse(vi.mocked(request).mock.calls.find(([p])=>p==='/gb28181/channel-config')![1]!.body as string)
 expect(body).toMatchObject({expectedRevision:7,deviceId:device,channelId:channel,transport:'udp',config:{name:'自定义入口',primary:'hls'}})
})
it('mapped edit preserves disabled input and all metadata in a single save',async()=>{
 mapped=true;const saved=vi.fn()
 render(<MemoryRouter><ChannelWizard open mode="edit" initial={mockChannels[0]} gbBinding={{input_id:mockChannels[0]!.id,device_id:device,channel_id:channel}} onClose={()=>{}} onSubmit={()=>{}} onGBSaved={saved}/></MemoryRouter>)
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'修改名称'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 await screen.findByRole('radio')
 expect(screen.getByLabelText('国标设备')).toBeDisabled()
 fireEvent.change(screen.getByLabelText('媒体传输方式'),{target:{value:'tcp-active'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 fireEvent.click(screen.getByTestId('wizard-submit'))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 const body=JSON.parse(vi.mocked(request).mock.calls.find(([p])=>p==='/gb28181/channel-config')![1]!.body as string)
 expect(body).toMatchObject({expectedRevision:7,inputId:mockChannels[0]!.id,enabled:false,transport:'tcp-active',config:{name:'修改名称'}})
})
it('cancelled GB draft never binds and Escape respects dirty confirmation',async()=>{
 const close=vi.fn(),confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={close} onSubmit={()=>{}}/></MemoryRouter>)
 await choose()
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'})
 expect(confirm).toHaveBeenCalled();expect(close).not.toHaveBeenCalled()
 confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'关闭'}))
 expect(close).toHaveBeenCalledOnce()
 expect(vi.mocked(request).mock.calls.some(([,o])=>o?.method==='POST')).toBe(false)
})
it('failed final save retains draft and does not report success',async()=>{
 const saved=vi.fn()
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}} onGBSaved={saved}/></MemoryRouter>)
 await choose();fireEvent.click(screen.getByTestId('wizard-next'))
 vi.mocked(request).mockRejectedValueOnce(new Error('配置已更新，请重新读取'))
 fireEvent.click(screen.getByTestId('wizard-submit'))
 await screen.findByText('配置已更新，请重新读取')
 expect(saved).not.toHaveBeenCalled();expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('batch NVR selection uses the same final save with channel-specific names',async()=>{
 const saved=vi.fn()
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}} onGBSaved={saved}/></MemoryRouter>)
 await choose()
 fireEvent.click(screen.getByLabelText('批量接入 NVR 视频通道'))
 fireEvent.click(screen.getByRole('checkbox',{name:/门口画面/}))
 fireEvent.click(screen.getByTestId('wizard-next'))
 expect(screen.getByText('自定义入口 · 门口画面')).toBeInTheDocument()
 fireEvent.click(screen.getByTestId('wizard-submit'))
 await waitFor(()=>expect(saved).toHaveBeenCalledOnce())
 const body=JSON.parse(vi.mocked(request).mock.calls.find(([p])=>p==='/gb28181/channel-configs')![1]!.body as string)
 expect(body.channels).toHaveLength(1)
 expect(body.channels[0]).toMatchObject({channelId:channel,config:{name:'自定义入口 · 门口画面'}})
})

it('runtime polling never advances an open configuration revision',async()=>{
 vi.useFakeTimers()
 try{
  const draft=vi.fn()
  await act(async()=>{render(<GBSourceFields binding={{revision:6,input_id:mockChannels[0]!.id,device_id:device,channel_id:channel}} onDraft={draft} onDirty={()=>{}} onBusy={()=>{}}/>);await Promise.resolve()})
  expect(draft.mock.lastCall?.[0].revision).toBe(6)
  vi.mocked(request).mockImplementation(async(path)=>path.endsWith('/channels')?{revision:99,items:[]} as never:{revision:99,devices:[]} as never)
  await act(async()=>{await vi.advanceTimersByTimeAsync(5100)})
  expect(draft.mock.lastCall?.[0].revision).toBe(6)
  expect(vi.mocked(request).mock.calls.filter(([p])=>p.startsWith('/gb28181/channel-options'))).toHaveLength(1)
 }finally{cleanup();vi.useRealTimers()}
})

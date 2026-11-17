import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {onvifService} from '@/api/onvifService'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
vi.mock('@/api/httpClient',()=>({request:vi.fn(async()=>({}))}))
vi.mock('@/api/ingestService',()=>({ingestService:{capabilities:vi.fn(async()=>({rtsp:{enabled:true},rtmp:{enabled:true}}))}}))
vi.mock('@/api/onvifService',()=>({onvifService:{devices:vi.fn(),device:vi.fn(),settings:vi.fn(),probe:vi.fn(),saveDevice:vi.fn(),saveChannel:vi.fn(),discover:vi.fn()}}))

const profile={service:'media2' as const,token:'main',name:'Main',videoSource:'source-a',videoCodec:'H264',audioCodec:'AAC',width:2560,height:1440,fps:25}
let profiles:typeof profile[],saved:{id:string;name:string}[]
const caps=()=>({manufacturer:'Dahua',model:'IPC',firmware:'1',serial:'s',clockVerified:true,clockOffsetSeconds:0,profiles,warnings:[]})
beforeEach(()=>{
 profiles=[profile];saved=[]
 vi.mocked(onvifService.settings).mockResolvedValue({revision:1,tokenSet:true,settings:{enabled:true,serviceUrl:'x',allowedCIDRs:['192.168.0.0/17'],interfaces:['eth0'],timeoutSeconds:5}})
 vi.mocked(onvifService.devices).mockImplementation(async()=>({items:saved.map(d=>({id:d.id,name:d.name,url:'http://192.168.1.219/onvif/device_service',username:'admin',version:1,certificateSHA256:'',credentialSet:true,capabilities:caps()}))}))
 vi.mocked(onvifService.device).mockImplementation(async id=>(await onvifService.devices()).items.find(d=>d.id===id)!)
 vi.mocked(onvifService.saveDevice).mockImplementation(async input=>{saved=[{id:'dev-new',name:input.name}];return {id:'dev-new',version:1} as never})
 vi.mocked(onvifService.probe).mockImplementation(async()=>({version:1,capabilities:caps()}) as never)
 vi.mocked(onvifService.discover).mockResolvedValue({items:[]})
 vi.mocked(onvifService.saveChannel).mockResolvedValue({} as never)
})
afterEach(()=>{cleanup();vi.clearAllMocks()})

async function openOnvif(){
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}} onOnvifSaved={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'大华ONVIF'}})
 fireEvent.click(screen.getByRole('button',{name:'ONVIF 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
 await screen.findByLabelText('ONVIF 服务地址')
}
const fill=()=>{
 fireEvent.change(screen.getByLabelText('ONVIF 服务地址'),{target:{value:'http://192.168.1.219/onvif/device_service'}})
 fireEvent.change(screen.getByLabelText('ONVIF 用户名'),{target:{value:'admin'}})
 fireEvent.change(screen.getByLabelText(/^密码/),{target:{value:'teche720'}})
}

it('has no separate save button for the device',async()=>{
 await openOnvif()
 expect(screen.queryByRole('button',{name:'保存设备并读取码流'})).toBeNull()
})

it('next connects, reads the streams and goes straight on when there is nothing to choose',async()=>{
 await openOnvif();fill()
 fireEvent.click(screen.getByTestId('wizard-next'))
 await waitFor(()=>expect(onvifService.saveDevice).toHaveBeenCalledOnce())
 expect(vi.mocked(onvifService.saveDevice).mock.calls[0]![0]).toMatchObject({name:'大华ONVIF',url:'http://192.168.1.219/onvif/device_service',username:'admin',password:'teche720'})
 expect(onvifService.probe).toHaveBeenCalledWith('dev-new')
 expect(await screen.findByTestId('wizard-submit')).toBeInTheDocument()
})

it('the device is named after the channel, so no name is typed twice',async()=>{
 await openOnvif();fill()
 fireEvent.click(screen.getByTestId('wizard-next'))
 await waitFor(()=>expect(onvifService.saveDevice).toHaveBeenCalledOnce())
 expect(vi.mocked(onvifService.saveDevice).mock.calls[0]![0]).toMatchObject({name:'大华ONVIF'})
})

it('stays on the page, with the new device selected, when several pictures need a choice',async()=>{
 profiles=[profile,{...profile,token:'other',videoSource:'source-b'}]
 await openOnvif();fill()
 fireEvent.click(screen.getByTestId('wizard-next'))
 await screen.findByLabelText('ONVIF 视频源')
 expect(screen.queryByTestId('wizard-submit')).toBeNull()
 // The device just configured is simply the current camera; no list asks to pick it again.
 expect(await screen.findByText(/当前摄像头/)).toHaveTextContent('大华ONVIF')
 expect(screen.queryByLabelText('ONVIF 设备')).toBeNull()
})

it('says what is missing instead of calling the camera when the address is empty',async()=>{
 await openOnvif()
 fireEvent.click(screen.getByTestId('wizard-next'))
 expect(await screen.findByText('请填写设备服务地址')).toBeInTheDocument()
 expect(onvifService.saveDevice).not.toHaveBeenCalled()
})

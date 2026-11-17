import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {onvifService} from '@/api/onvifService'
import {PasswordInput} from '@/components/ui/PasswordInput'
import {GBSourceFields} from '@/pages/Channels/GBSourceFields'
import {OnvifSourceFields} from '@/pages/Channels/OnvifSourceFields'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
vi.mock('@/api/ingestService',()=>({ingestService:{capabilities:vi.fn(async()=>({rtsp:{enabled:true},rtmp:{enabled:true},srt:{enabled:true},webrtc:{enabled:true}}))}}))
vi.mock('@/api/onvifService',()=>({onvifService:{devices:vi.fn(),device:vi.fn(),settings:vi.fn(),probe:vi.fn(),saveDevice:vi.fn(),discover:vi.fn()}}))

const profile={service:'media2' as const,token:'main',name:'Main',videoSource:'source-a',videoCodec:'H264',audioCodec:'AAC',width:2560,height:1440,fps:25}
const known={id:'dev-1',name:'已有摄像头',url:'http://192.168.1.50/onvif/device_service',username:'admin',version:1,certificateSHA256:'',credentialSet:true,
 capabilities:{manufacturer:'T',model:'M',firmware:'1',serial:'s',clockVerified:true,clockOffsetSeconds:0,profiles:[profile],warnings:[]}}
beforeEach(()=>{
 vi.mocked(request).mockReset().mockImplementation(async(path)=>{
  if(path.startsWith('/gb28181/channel-options'))return {revision:1,devices:[],items:[]} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'1',realm:'2',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return {state:'running',devices:[],unknownDevices:[]} as never
 })
 vi.mocked(onvifService.settings).mockResolvedValue({revision:1,tokenSet:true,settings:{enabled:true,serviceUrl:'x',allowedCIDRs:['192.168.0.0/17'],interfaces:[],timeoutSeconds:5}})
 vi.mocked(onvifService.devices).mockResolvedValue({items:[known]})
 vi.mocked(onvifService.device).mockResolvedValue(known)
})
afterEach(()=>{cleanup();vi.clearAllMocks()})

it('PasswordInput hides the text until the eye is pressed, and hides it again',()=>{
 render(<PasswordInput aria-label="密码" value="teche720" onChange={()=>{}}/>)
 const field=screen.getByLabelText('密码') as HTMLInputElement
 expect(field.type).toBe('password')
 fireEvent.click(screen.getByRole('button',{name:'显示密码'}))
 expect(field.type).toBe('text')
 fireEvent.click(screen.getByRole('button',{name:'隐藏密码'}))
 expect(field.type).toBe('password')
})

it('the ONVIF camera password can be revealed to check it',async()=>{
 render(<MemoryRouter><OnvifSourceFields onDraft={()=>{}} onBusy={()=>{}} onDirty={()=>{}}/></MemoryRouter>)
 await screen.findByLabelText('ONVIF 服务地址')
 const field=screen.getByLabelText(/^密码/) as HTMLInputElement
 expect(field.type).toBe('password')
 fireEvent.click(screen.getByRole('button',{name:'显示密码'}))
 expect(field.type).toBe('text')
})

it('the GB registration password can be revealed to check it',async()=>{
 render(<MemoryRouter><GBSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/></MemoryRouter>)
 const field=(await screen.findByLabelText('注册密码')) as HTMLInputElement
 fireEvent.click(within(field.closest('label')!).getByRole('button',{name:'显示密码'}))
 expect(field.type).toBe('text')
})

it('the RTSP camera password can be revealed to check it',async()=>{
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}}/></MemoryRouter>)
 await waitFor(()=>expect(screen.getByRole('button',{name:'RTSP 摄像头拉流'})).not.toBeDisabled())
 fireEvent.click(screen.getByRole('button',{name:'RTSP 摄像头拉流'}))
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'相机'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 const field=await screen.findByLabelText(/相机密码/) as HTMLInputElement
 fireEvent.click(screen.getByRole('button',{name:'显示密码'}))
 expect(field.type).toBe('text')
})

it('adding a camera starts as that camera, without a device list to choose from',async()=>{
 render(<MemoryRouter><OnvifSourceFields onDraft={()=>{}} onBusy={()=>{}} onDirty={()=>{}}/></MemoryRouter>)
 await screen.findByLabelText('ONVIF 服务地址')
 await new Promise(r=>setTimeout(r,100))
 expect(screen.queryByRole('button',{name:/改用/})).toBeNull()
 expect(screen.queryByLabelText('ONVIF 设备')).toBeNull()
})

it('after connecting, the device just configured is the current one and nothing asks to choose it again',async()=>{
 vi.mocked(onvifService.devices).mockResolvedValue({items:[]})
 vi.mocked(onvifService.saveDevice).mockImplementation(async()=>{vi.mocked(onvifService.devices).mockResolvedValue({items:[known]});return {id:'dev-1',version:1} as never})
 vi.mocked(onvifService.probe).mockResolvedValue({version:1,capabilities:known.capabilities} as never)
 let connect:(()=>Promise<unknown>)|undefined
 render(<MemoryRouter><OnvifSourceFields onDraft={()=>{}} onBusy={()=>{}} onDirty={()=>{}} onPrepare={fn=>{connect=fn}}/></MemoryRouter>)
 fireEvent.change(await screen.findByLabelText('ONVIF 服务地址'),{target:{value:'http://192.168.1.50/onvif/device_service'}})
 await waitFor(()=>expect(connect).toBeDefined())
 await connect!()
 expect(await screen.findByText(/已有摄像头/)).toBeInTheDocument()
 expect(screen.queryByLabelText('ONVIF 设备')).toBeNull()
})

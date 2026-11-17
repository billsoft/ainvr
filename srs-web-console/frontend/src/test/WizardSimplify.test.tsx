import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {onvifService} from '@/api/onvifService'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
import {GBSourceFields,type GBSourceDraft} from '@/pages/Channels/GBSourceFields'
import {OnvifSourceFields} from '@/pages/Channels/OnvifSourceFields'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
vi.mock('@/api/ingestService',()=>({ingestService:{capabilities:vi.fn(async()=>({rtsp:{enabled:true},rtmp:{enabled:true},srt:{enabled:true},webrtc:{enabled:true}}))}}))
vi.mock('@/api/onvifService',()=>({onvifService:{devices:vi.fn(),device:vi.fn(),settings:vi.fn(),probe:vi.fn(),saveDevice:vi.fn(),saveChannel:vi.fn(),discover:vi.fn()}}))

const dev='34020000001320000001',a='34020000001310000001',b='34020000001310000002'
let devices:unknown[],items:unknown[],status:Record<string,unknown>
const item=(id:string,extra={})=>({id,document:{name:`画面${id.slice(-1)}`},available:true,enabled:true,transport:'tcp-passive',...extra})
beforeEach(()=>{
 devices=[{id:dev,name:'大华双目',version:'auto',enabled:true}];items=[];status={state:'running',devices:[{id:dev,registered:true}],unknownDevices:[]}
 vi.mocked(request).mockReset().mockImplementation(async(path)=>{
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices,items:path.includes('?')?items:[]} as never
  if(path.endsWith('/channels'))return {items} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'1',realm:'2',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return status as never
 })
})
afterEach(()=>{cleanup();vi.clearAllMocks()})
function gb(defaultName='大华双目'){
 let draft:GBSourceDraft|undefined
 render(<MemoryRouter><GBSourceFields defaultName={defaultName} onDraft={d=>{draft=d}} onDirty={()=>{}} onBusy={()=>{}}/></MemoryRouter>)
 return ()=>draft!
}

/** An already registered number is that device: typing it and saving is how this page comes to show its catalogue. */
async function registerKnown(draft:()=>GBSourceDraft){
 fireEvent.change(await screen.findByLabelText('设备国标编号（20 位）'),{target:{value:dev}})
 await act(async()=>{await draft().saveRegistration()})
}

it('GB: adding a camera never preselects an existing device and offers no device list',async()=>{
 const draft=gb()
 await waitFor(()=>expect(draft().ready).toBe(true))
 await new Promise(r=>setTimeout(r,100))
 expect(draft().deviceId).toBe('')
 expect(screen.queryByLabelText('国标设备')).toBeNull()
 expect(await screen.findByLabelText('设备国标编号（20 位）')).toBeInTheDocument()
})

it('GB: with no device yet the registration form is already open, named after the channel',async()=>{
 devices=[]
 gb('我的摄像头')
 expect(await screen.findByText('登记这台摄像头')).toBeInTheDocument()
 expect(screen.queryByLabelText('设备名称')).toBeNull()
 expect(screen.queryByRole('button',{name:'登记新设备'})).toBeNull()
})

it('GB: a new device asks for number and password; the rest is under advanced',async()=>{
 devices=[]
 gb()
 await screen.findByLabelText('设备国标编号（20 位）')
 expect(screen.queryByLabelText('允许此设备注册')).toBeNull()
 expect(screen.getByLabelText('协议版本').closest('details')).not.toBeNull()
})

it('GB: batch, search, refresh and reload controls appear only when they have a use',async()=>{
 items=[item(a)]
 const draft=gb()
 await registerKnown(draft)
 await waitFor(()=>expect(draft().channelId).toBe(a))
 expect(screen.queryByLabelText('批量接入 NVR 视频通道')).toBeNull()
 expect(screen.queryByLabelText('搜索视频目录')).toBeNull()
 expect(screen.queryByRole('button',{name:'刷新设备目录'})).toBeNull()
 expect(screen.queryByRole('button',{name:'重新读取配置'})).toBeNull()
})

it('GB: several free channels bring back batch selection',async()=>{
 items=[item(a),item(b)]
 const draft=gb()
 await registerKnown(draft)
 expect(await screen.findByLabelText('批量接入 NVR 视频通道')).toBeInTheDocument()
})

it('GB: an empty catalogue offers a refresh',async()=>{
 const draft=gb()
 await registerKnown(draft)
 expect(await screen.findByRole('button',{name:'刷新设备目录'})).toBeInTheDocument()
})

it('GB: the platform parameters fold away once the chosen device is registered',async()=>{
 items=[item(a)]
 const draft=gb()
 await registerKnown(draft)
 const card=(await screen.findByText('摄像头端填写的平台参数')).closest('details')!
 expect(card).not.toBeNull()
 expect(card.open).toBe(false)
})

const profile={service:'media2' as const,token:'main',name:'Main',videoSource:'source-a',videoCodec:'H264',audioCodec:'AAC',width:1920,height:1080,fps:25}
const mjpeg={...profile,token:'mjpeg',name:'Mjpeg',videoCodec:'JPEG',width:3840,height:2160}
function onvif(profiles:typeof profile[]){
 const d={id:'dev-1',name:'摄像头',url:'http://192.168.1.50/onvif/device_service',username:'admin',version:1,certificateSHA256:'',credentialSet:true,
  capabilities:{manufacturer:'T',model:'M',firmware:'1',serial:'s',clockVerified:true,clockOffsetSeconds:0,profiles,warnings:[]}}
 vi.mocked(onvifService.settings).mockResolvedValue({revision:1,tokenSet:true,settings:{enabled:true,serviceUrl:'x',allowedCIDRs:['192.168.0.0/17'],interfaces:[],timeoutSeconds:5}})
 vi.mocked(onvifService.devices).mockResolvedValue({items:[]})
 vi.mocked(onvifService.saveDevice).mockImplementation(async()=>{vi.mocked(onvifService.devices).mockResolvedValue({items:[d]});return {id:'dev-1',version:1} as never})
 vi.mocked(onvifService.probe).mockResolvedValue({version:1,capabilities:d.capabilities} as never)
 vi.mocked(onvifService.device).mockResolvedValue(d)
 let connect:(()=>Promise<unknown>)|undefined
 render(<MemoryRouter><OnvifSourceFields defaultName="大华ONVIF" onDraft={()=>{}} onBusy={()=>{}} onDirty={()=>{}} onPrepare={fn=>{connect=fn}}/></MemoryRouter>)
 return async()=>{await screen.findByLabelText('ONVIF 服务地址');await waitFor(()=>expect(connect).toBeDefined());return connect!()}
}

it('ONVIF: the default stream is never one the device cannot ingest',async()=>{
 const run=onvif([mjpeg,profile])
 fireEvent.change(await screen.findByLabelText('ONVIF 服务地址'),{target:{value:'192.168.1.50'}})
 expect(await run()).toMatchObject({profileToken:'main'})
})

it('ONVIF: a bare IP is expanded to the standard device service address',async()=>{
 const run=onvif([profile])
 fireEvent.change(await screen.findByLabelText('ONVIF 服务地址'),{target:{value:'192.168.1.50'}})
 await run()
 expect(vi.mocked(onvifService.saveDevice).mock.calls[0]![0]).toMatchObject({url:'http://192.168.1.50/onvif/device_service'})
})

it('ONVIF: no device name is asked for; it takes the channel name',async()=>{
 const run=onvif([profile])
 fireEvent.change(await screen.findByLabelText('ONVIF 服务地址'),{target:{value:'192.168.1.50'}})
 expect(screen.queryByLabelText('ONVIF 设备名称')).toBeNull()
 await run()
 expect(vi.mocked(onvifService.saveDevice).mock.calls[0]![0]).toMatchObject({name:'大华ONVIF'})
})

it('the enable switch reads the same in every protocol',async()=>{
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}}/></MemoryRouter>)
 await waitFor(()=>expect(screen.getByRole('button',{name:'RTSP 摄像头拉流'})).not.toBeDisabled())
 fireEvent.click(screen.getByRole('button',{name:'RTSP 摄像头拉流'}))
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'相机'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 expect(await screen.findByLabelText(/^启用此通道/)).toBeInTheDocument()
})

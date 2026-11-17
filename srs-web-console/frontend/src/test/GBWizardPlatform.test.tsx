import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
import {GBConfigForm} from '@/pages/ConfigCenter/GBConfigForm'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const unknown='34020000001320000001'
let settings:Record<string,unknown>,status:Record<string,unknown>
const base={enabled:true,gatewayUrl:'http://127.0.0.1:8096',serverId:'34020000002000000001',realm:'3402000000',listenIp:'0.0.0.0',sipPort:5060,advertiseIp:'192.168.100.190',mediaAdvertiseIp:'192.168.100.190',mediaPortStart:30000,mediaPortEnd:30100,capacity:4,heartbeatTimeoutSec:180}
beforeEach(()=>{
 settings={...base};status={state:'running',devices:[],unknownDevices:[{id:unknown,address:'192.168.1.219:5060',lastAttempt:'2026-11-16T03:00:00Z'}]}
 vi.mocked(request).mockReset().mockImplementation(async(path)=>{
  if(path==='/gb28181/settings')return {revision:5,settings,tokenSet:true,addresses:['192.168.100.190']} as never
  if(path==='/gb28181/status')return status as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:[],items:[]} as never
  if(path==='/gb28181/devices')return {revision:7,items:[]} as never
  return {} as never
 })
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})

async function openGB(){
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'大华双目'}})
 fireEvent.click(screen.getByRole('button',{name:'GB/T 28181 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
}
const wizard=()=>render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}}/></MemoryRouter>)

it('shows the platform parameters the camera must be given, with copy buttons',async()=>{
 wizard();await openGB()
 const card=await screen.findByRole('region',{name:'摄像头端填写的平台参数'})
 for(const text of ['34020000002000000001','3402000000','192.168.100.190','5060'])expect(within(card).getByText(text)).toBeInTheDocument()
 expect(within(card).getAllByRole('button',{name:/^复制/}).length).toBe(4)
})

it('blocks with a link to system configuration when the gateway is off',async()=>{
 settings={...base,enabled:false}
 wizard();await openGB()
 const alert=await screen.findByRole('alert',{name:'国标网关未启用'})
 expect(within(alert).getByRole('link',{name:/系统配置/})).toHaveAttribute('href','/config-center?category=gb28181')
})

it('warns when the advertised address is loopback and the camera could not reach it',async()=>{
 settings={...base,advertiseIp:'127.0.0.1'}
 wizard();await openGB()
 expect(await screen.findByRole('alert',{name:'摄像头无法访问平台地址'})).toBeInTheDocument()
})

it('lists unregistered numbers before any device is chosen and registers one with a click',async()=>{
 wizard();await openGB()
 const list=await screen.findByRole('region',{name:'收到注册请求的未登记设备'})
 expect(within(list).getByText(new RegExp(unknown))).toBeInTheDocument()
 fireEvent.click(within(list).getByRole('button',{name:'登记此编号'}))
 const form=await screen.findByRole('region',{name:'设备注册信息'})
 expect(within(form).getByLabelText('设备国标编号（20 位）')).toHaveValue(unknown)
})

it('reads the runtime status once even while the page is in the background',async()=>{
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>true})
 try{
  wizard();await openGB()
  await waitFor(()=>expect(vi.mocked(request).mock.calls.some(([p])=>p==='/gb28181/status')).toBe(true))
 }finally{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false})}
})

it('system configuration keeps gateway parameters only and points devices to access management',async()=>{
 render(<MemoryRouter><GBConfigForm/></MemoryRouter>)
 await screen.findByText('国标摄像头接入')
 expect(screen.queryByRole('region',{name:'国标设备'})).toBeNull()
 expect(screen.getByRole('link',{name:/接入管理/})).toHaveAttribute('href','/channels')
})

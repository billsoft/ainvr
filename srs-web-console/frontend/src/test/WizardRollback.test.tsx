import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {onvifService} from '@/api/onvifService'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
import {OnvifSourceFields} from '@/pages/Channels/OnvifSourceFields'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
vi.mock('@/api/onvifService',()=>({onvifService:{devices:vi.fn(),device:vi.fn(),settings:vi.fn(),probe:vi.fn(),saveDevice:vi.fn(),removeDevice:vi.fn()}}))

const id='34020000001320000001'
let known:boolean
beforeEach(()=>{
 known=false
 vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
  if(options?.method)return {revision:8} as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:known?[{id,name:'大厅 NVR',version:'auto',enabled:true}]:[],items:[]} as never
  if(path.endsWith('/channels'))return {items:[]} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'34020000002000000001',realm:'3402000000',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return {state:'running',devices:[],unknownDevices:known?[]:[{id,address:'192.168.1.219:5060',lastAttempt:'2026-11-16T03:00:00Z'}]} as never
 })
})
afterEach(()=>{cleanup();vi.clearAllMocks()})
const gbWrites=(method:string)=>vi.mocked(request).mock.calls.filter(([p,o])=>String(p).startsWith('/gb28181/devices')&&o?.method===method)

async function openWizard(){
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'大华双目'}})
 fireEvent.click(screen.getByRole('button',{name:'GB/T 28181 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
}
const escape=()=>fireEvent.keyDown(screen.getByTestId('wizard-next'),{key:'Escape'})

describe('GB: a camera registered only for an abandoned wizard is taken back',()=>{
 it('deletes it when the wizard is cancelled after the registration was saved',async()=>{
  await openWizard()
  const chip=await screen.findByRole('button',{name:'登记此编号'})
  await waitFor(()=>expect(chip).toBeEnabled(),{timeout:8000})
  fireEvent.click(chip)
  fireEvent.change(screen.getByLabelText('注册密码'),{target:{value:'teche720'}})
  fireEvent.click(screen.getByTestId('wizard-next'))
  await waitFor(()=>expect(gbWrites('POST')).toHaveLength(1),{timeout:8000})
  await screen.findByText(/设备注册信息已保存/,{},{timeout:8000})
  escape()
  fireEvent.click(await screen.findByRole('button',{name:'放弃修改'}))
  await waitFor(()=>expect(gbWrites('DELETE')).toHaveLength(1),{timeout:8000})
  expect(gbWrites('DELETE')[0]![0]).toBe(`/gb28181/devices/${id}`)
 },20000)

 it('writes and deletes nothing for a number that was already registered',async()=>{
  known=true
  await openWizard()
  fireEvent.change(await screen.findByLabelText('设备国标编号（20 位）',{},{timeout:8000}),{target:{value:id}})
  expect(await screen.findByText(/将直接使用它，不会修改它的注册信息/)).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('wizard-next'))
  await waitFor(()=>expect(screen.getByText(/当前摄像头/)).toBeInTheDocument(),{timeout:8000})
  expect(gbWrites('POST')).toHaveLength(0)
  escape()
  fireEvent.click(await screen.findByRole('button',{name:'放弃修改'}))
  await new Promise(r=>setTimeout(r,200))
  expect(gbWrites('DELETE')).toHaveLength(0)
 },20000)
})

describe('ONVIF: a camera registered only for an abandoned wizard is taken back',()=>{
 it('removes the new device, and leaves an existing one alone',async()=>{
  vi.mocked(onvifService.devices).mockResolvedValue({items:[]} as never)
  vi.mocked(onvifService.settings).mockResolvedValue({revision:1,tokenSet:true,settings:{enabled:true,serviceUrl:'http://127.0.0.1:8150',allowedCIDRs:['192.0.2.0/24'],interfaces:[],timeoutSeconds:3}} as never)
  vi.mocked(onvifService.saveDevice).mockResolvedValue({id:'new-dev',version:1} as never)
  vi.mocked(onvifService.device).mockResolvedValue({id:'new-dev',version:2} as never)
  vi.mocked(onvifService.probe).mockResolvedValue({version:2,capabilities:{profiles:[]}} as never)
  let connect:(()=>Promise<unknown>)|undefined,discard:(()=>Promise<void>)|undefined
  render(<MemoryRouter><OnvifSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}} onPrepare={f=>{connect=f}} onCleanup={f=>{discard=f}}/></MemoryRouter>)
  fireEvent.change(await screen.findByLabelText('ONVIF 服务地址'),{target:{value:'192.168.1.219'}})
  fireEvent.change(screen.getByLabelText('ONVIF 用户名'),{target:{value:'admin'}})
  fireEvent.change(screen.getByLabelText(/^密码/),{target:{value:'teche720'}})
  await waitFor(()=>expect(connect).toBeDefined())
  await connect!().catch(()=>null)
  expect(onvifService.saveDevice).toHaveBeenCalledTimes(1)
  await discard!()
  expect(onvifService.removeDevice).toHaveBeenCalledWith('new-dev',2)
  await discard!()
  expect(onvifService.removeDevice).toHaveBeenCalledTimes(1)
 },20000)
})

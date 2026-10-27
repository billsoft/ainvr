import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {GBSourceFields} from '@/pages/Channels/GBSourceFields'
import {GBConfigForm} from '@/pages/ConfigCenter/GBConfigForm'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
const id='34020000001320000001',channel='34020000001320000002'
beforeEach(()=>{
 vi.mocked(request).mockReset().mockImplementation(async (path,options)=>{
  if(options?.method)return {revision:8} as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:[{id,name:'测试设备',version:'2016',enabled:true}],items:[]} as never
  if(path==='/gb28181/devices')return {revision:7,items:[{id,name:'测试设备',version:'2016',enabled:true,updated_at:'2026-10-25T01:00:00Z'}]} as never
  if(path.endsWith('/channels'))return {items:[{id:channel,document:{name:'入口'},available:true}]} as never
  if(path==='/gb28181/settings')return {revision:7,tokenSet:true,settings:{enabled:false,gatewayUrl:'http://127.0.0.1:8096',serverId:'34020000002000000001',realm:'3402000000',listenIp:'0.0.0.0',sipPort:5060,advertiseIp:'192.0.2.1',mediaAdvertiseIp:'192.0.2.1',mediaPortStart:30000,mediaPortEnd:30100,capacity:4,heartbeatTimeoutSec:180}} as never
  return {state:'disabled',revision:7,devices:[],inputs:[]} as never
 })
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('active device form protects close and Escape without saving discarded drafts',async()=>{
 const confirm=vi.spyOn(window,'confirm')
 render(<GBSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/>)
 await screen.findByRole('option',{name:`测试设备 · ${id}`})
 fireEvent.click(screen.getByRole('button',{name:'登记新设备'}))
 fireEvent.click(screen.getByRole('button',{name:'关闭设备注册信息'}))
 expect(confirm).not.toHaveBeenCalled()
 fireEvent.click(screen.getByRole('button',{name:'登记新设备'}))
 fireEvent.change(screen.getByLabelText('设备名称'),{target:{value:'草稿'}})
 fireEvent.keyDown(screen.getByRole('region',{name:'设备注册信息'}),{key:'Escape'})
 expect(screen.getByLabelText('设备名称')).toHaveValue('草稿')
 fireEvent.click(screen.getByRole('button',{name:'继续编辑'}))
 expect(screen.getByLabelText('设备名称')).toHaveValue('草稿')
 fireEvent.click(screen.getByRole('button',{name:'关闭设备注册信息'}))
 const dialog=screen.getByRole('dialog',{name:'放弃未保存的修改？'})
 fireEvent.click(within(dialog).getByRole('button',{name:'关闭'}))
 expect(screen.getByLabelText('设备名称')).toHaveValue('草稿')
 fireEvent.click(screen.getByRole('button',{name:'取消设备修改'}))
 fireEvent.click(screen.getByRole('button',{name:'放弃修改'}))
 expect(screen.queryByLabelText('设备名称')).toBeNull()
 expect(confirm).not.toHaveBeenCalled()
 expect(vi.mocked(request).mock.calls.some(([,o])=>o?.method==='POST')).toBe(false)
})
it('active wizard saves registration only and preserves a blank password',async()=>{
 render(<GBSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/>)
 await screen.findByRole('option',{name:`测试设备 · ${id}`})
 fireEvent.change(screen.getByLabelText('国标设备'),{target:{value:id}})
 await waitFor(()=>expect(screen.getByLabelText('国标设备')).not.toBeDisabled())
 fireEvent.click(screen.getByRole('button',{name:'编辑设备注册信息'}))
 fireEvent.change(screen.getByLabelText('设备名称'),{target:{value:'新名称'}})
 fireEvent.click(screen.getByRole('button',{name:'保存注册信息'}))
 await waitFor(()=>expect(vi.mocked(request).mock.calls.some(([p,o])=>p==='/gb28181/devices'&&o?.method==='POST')).toBe(true))
 const writes=vi.mocked(request).mock.calls.filter(([,o])=>o?.method==='POST')
 expect(writes).toHaveLength(1)
 const payload=JSON.parse(writes[0]![1]!.body as string)
 expect(payload).toMatchObject({expectedRevision:7,device:{id,name:'新名称'}})
 expect(payload.device).not.toHaveProperty('password')
 expect(payload.device).not.toHaveProperty('updated_at')
})
it('configuration marks unsaved edits and sends no empty replacement credential',async()=>{
 const {container}=render(<GBConfigForm/>)
 fireEvent.change(await screen.findByLabelText('同时收流上限'),{target:{value:'3'}})
 expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'保存国标配置'}))
 await screen.findByText('已保存，等待国标网关应用。监听参数变更会重建国标连接。')
 const call=vi.mocked(request).mock.calls.find(([,o])=>o?.method==='PUT')!
 const payload=JSON.parse(call[1]!.body as string)
 expect(payload.settings.capacity).toBe(3);expect(payload.expectedRevision).toBe(7)
 expect(payload.token).toBeUndefined();expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
})

it('shows selected compatibility separately from the device declaration',async()=>{
 const original=vi.mocked(request).getMockImplementation()!
 vi.mocked(request).mockImplementation(async(path,options)=>path==='/gb28181/status'?{state:'ready',devices:[{id,registered:true,version:{profile:'2016',confirmed:true,peer:'2022'}}]} as never:original(path,options))
 render(<GBSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/>)
 await screen.findByRole('option',{name:`测试设备 · ${id}`})
 fireEvent.change(screen.getByLabelText('国标设备'),{target:{value:id}})
 expect(await screen.findByText('当前兼容配置：2016 · 设备声明：2022')).toBeInTheDocument()
 expect(screen.getByText(/不代表通过完整标准认证/)).toBeInTheDocument()
})

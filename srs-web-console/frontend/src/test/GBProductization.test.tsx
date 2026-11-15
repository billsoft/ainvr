import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {GBDeviceManager} from '@/pages/ConfigCenter/GBDeviceManager'
import {GBConfigForm} from '@/pages/ConfigCenter/GBConfigForm'
import {GBSourceFields} from '@/pages/Channels/GBSourceFields'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const nvr='34020000001320000001',cam='34020000001320000011',typo='34020000001320000099'
const settings={enabled:false,gatewayUrl:'http://127.0.0.1:8096',serverId:'34020000002000000001',realm:'3402000000',listenIp:'0.0.0.0',sipPort:5060,advertiseIp:'127.0.0.1',mediaAdvertiseIp:'127.0.0.1',mediaPortStart:30000,mediaPortEnd:30100,capacity:8,heartbeatTimeoutSec:180}
const catalog=Array.from({length:450},(_,i)=>({id:`3402000000132${String(1000000+i)}`,document:{name:`通道${i}`},available:true}))
const status={state:'running',devices:[
 {id:nvr,registered:true,address:'192.168.100.61:5060',lastSeen:'2026-11-15T10:00:00Z',version:{profile:'2022'}},
 {id:cam,registered:false,lastError:'authentication_failed'},
],unknownDevices:[{id:typo,address:'192.168.100.77:5060',lastAttempt:'2026-11-15T10:01:00Z'}]}
beforeEach(()=>{
 vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
  if(options?.method)return {revision:4} as never
  if(path==='/gb28181/devices')return {revision:3,items:[{id:nvr,name:'大厅 NVR',version:'auto',enabled:true,mediaIPs:[],channels:12},{id:cam,name:'后门',version:'2016',enabled:true,mediaIPs:[],channels:0}]} as never
  if(path==='/gb28181/status')return status as never
  if(path==='/gb28181/settings')return {revision:3,tokenSet:true,settings,capacityLimit:8,addresses:['192.168.100.190']} as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:3,devices:[{id:nvr,name:'大厅 NVR',version:'auto',enabled:true}],items:catalog} as never
  if(path.endsWith('/channels'))return {items:catalog} as never
  return {} as never
 })
})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
const writes=()=>vi.mocked(request).mock.calls.filter(([,o])=>o?.method)

it('lists every device with its registration state, address and channel count',async()=>{
 render(<GBDeviceManager/>)
 const row=(await screen.findByText(/大厅 NVR/)).closest('li')!
 await within(row).findByText('在线')
 expect(within(row).getByText(/地址 192\.168\.100\.61 .* 协议 2022 · 已接入 12 路/)).toBeInTheDocument()
 const back=screen.getByText(/后门/).closest('li')!
 expect(within(back).getByText(/注册密码不正确/)).toBeInTheDocument()
})

it('turns a mistyped device number into a one-step registration',async()=>{
 render(<GBDeviceManager/>)
 expect(await screen.findByText(new RegExp(`${typo} · 来自 192\\.168\\.100\\.77`))).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'登记此编号'}))
 expect(screen.getByLabelText('设备国标编号（20 位）')).toHaveValue(typo)
 fireEvent.change(screen.getByLabelText('设备名称'),{target:{value:'侧门'}})
 fireEvent.change(screen.getByLabelText('注册密码'),{target:{value:'camera-pass-1'}})
 fireEvent.click(screen.getByRole('button',{name:'保存设备'}))
 await waitFor(()=>expect(writes()).toHaveLength(1))
 expect(JSON.parse(writes()[0]![1]!.body as string)).toMatchObject({expectedRevision:3,device:{id:typo,name:'侧门',enabled:true,password:'camera-pass-1'}})
})

it('disables without touching the password and deletes only after confirmation',async()=>{
 render(<GBDeviceManager/>)
 const row=(await screen.findByText(/后门/)).closest('li')!
 fireEvent.click(within(row).getByRole('button',{name:'停用'}))
 await waitFor(()=>expect(writes()).toHaveLength(1))
 const disable=JSON.parse(writes()[0]![1]!.body as string)
 expect(disable.device).toMatchObject({id:cam,enabled:false});expect(disable.device).not.toHaveProperty('password')
 fireEvent.click(within(row).getByRole('button',{name:'删除'}))
 expect(writes()).toHaveLength(1)
 fireEvent.click(within(row).getByRole('button',{name:'确认删除'}))
 await waitFor(()=>expect(writes()).toHaveLength(2))
 expect(writes()[1]![0]).toBe(`/gb28181/devices/${cam}`);expect(writes()[1]![1]!.method).toBe('DELETE')
})

it('states the board limit and fills this host\'s address instead of loopback',async()=>{
 render(<GBConfigForm/>)
 expect(await screen.findByText(/本机最多同时接入 8 路国标视频/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'使用 192.168.100.190'}))
 expect(screen.getByLabelText('摄像头可访问的信令地址')).toHaveValue('192.168.100.190')
 expect(screen.getByLabelText('摄像头可访问的媒体地址')).toHaveValue('192.168.100.190')
 fireEvent.click(screen.getByRole('button',{name:'保存国标配置'}))
 await waitFor(()=>expect(writes().some(([p])=>p==='/gb28181/settings')).toBe(true))
 const saved=JSON.parse(writes().find(([p])=>p==='/gb28181/settings')![1]!.body as string)
 expect(saved.settings).toMatchObject({advertiseIp:'192.168.100.190',mediaAdvertiseIp:'192.168.100.190'})
})

it('pages a large NVR catalog and selects all addable channels at once',async()=>{
 render(<GBSourceFields onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/>)
 await screen.findByRole('option',{name:`大厅 NVR · ${nvr}`})
 fireEvent.change(screen.getByLabelText('国标设备'),{target:{value:nvr}})
 expect(await screen.findByText('目录共 450 项，仅显示前 200 项，请输入名称或编号筛选。')).toBeInTheDocument()
 expect(screen.getAllByRole('radio')).toHaveLength(200)
 fireEvent.change(screen.getByLabelText('搜索视频目录'),{target:{value:'通道44'}})
 expect(screen.getAllByRole('radio')).toHaveLength(11)
 fireEvent.click(screen.getByLabelText('批量接入 NVR 视频通道'))
 fireEvent.click(screen.getByRole('button',{name:'全选可接入的 11 路'}))
 expect(screen.getByText(/已选 11 路/)).toBeInTheDocument()
})

import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
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

// Device list, one-step registration of a mistyped number, disable and delete now live in the
// wizard and on the channel rows: see GBWizardPlatform, GBWizardDeviceDelete and ChannelDeviceInfo tests.

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
 let draft:{saveRegistration:()=>Promise<boolean>}|undefined
 render(<GBSourceFields onDraft={d=>{draft=d}} onDirty={()=>{}} onBusy={()=>{}}/>)
 // The NVR's number is already registered, so typing it is how this page comes to show its catalogue.
 fireEvent.change(await screen.findByLabelText('设备国标编号（20 位）'),{target:{value:nvr}})
 await act(async()=>{await draft!.saveRegistration()})
 expect(await screen.findByText('目录共 450 项，仅显示前 200 项，请输入名称或编号筛选。')).toBeInTheDocument()
 expect(screen.getAllByRole('radio')).toHaveLength(200)
 fireEvent.change(screen.getByLabelText('搜索视频目录'),{target:{value:'通道44'}})
 expect(screen.getAllByRole('radio')).toHaveLength(11)
 fireEvent.click(screen.getByLabelText('批量接入 NVR 视频通道'))
 fireEvent.click(screen.getByRole('button',{name:'全选可接入的 11 路'}))
 expect(screen.getByText(/已选 11 路/)).toBeInTheDocument()
})

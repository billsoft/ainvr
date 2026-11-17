import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {GBSourceFields} from '@/pages/Channels/GBSourceFields'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const dev='34020000001320000001'
let items:unknown[]
beforeEach(()=>{
 items=[]
 vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
  if(options?.method)return {revision:8} as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:[{id:dev,name:'大华双目',version:'auto',enabled:true}],items:path.includes('?')?items:[]} as never
  if(path.endsWith('/channels'))return {items} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'34020000002000000001',realm:'3402000000',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return {state:'running',devices:[],unknownDevices:[]} as never
 })
})
afterEach(cleanup)
async function openEdit(){
 render(<GBSourceFields binding={{input_id:'in-1',device_id:dev,channel_id:'34020000001310000001'}} onDraft={()=>{}} onDirty={()=>{}} onBusy={()=>{}}/>)
 fireEvent.click(await screen.findByRole('button',{name:'编辑设备注册信息'}))
}
const deletes=()=>vi.mocked(request).mock.calls.filter(([,o])=>o?.method==='DELETE')

it('removes a device with no video channels after an explicit confirmation',async()=>{
 await openEdit()
 fireEvent.click(await screen.findByRole('button',{name:'删除此设备'}))
 expect(deletes()).toHaveLength(0)
 fireEvent.click(screen.getByRole('button',{name:'确认删除设备'}))
 await waitFor(()=>expect(deletes()).toHaveLength(1))
 expect(deletes()[0]![0]).toBe(`/gb28181/devices/${dev}`)
 expect(JSON.parse(deletes()[0]![1]!.body as string)).toMatchObject({expectedRevision:7})
})

it('refuses to remove a device while video channels still use it',async()=>{
 items=[{id:'34020000001310000001',document:{name:'画面'},available:true,input_id:'in-1',enabled:true,transport:'udp'}]
 await openEdit()
 const button=await screen.findByRole('button',{name:'删除此设备'})
 expect(button).toBeDisabled()
 expect(screen.getByText(/仍有 1 路视频通道在用/)).toBeInTheDocument()
})

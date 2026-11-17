import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const id='34020000001320000001'
beforeEach(()=>{
 vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
  if(options?.method)return {revision:8} as never
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices:[],items:[]} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'34020000002000000001',realm:'3402000000',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return {state:'running',devices:[],unknownDevices:[{id,address:'192.168.1.219:5060',lastAttempt:'2026-11-16T03:00:00Z'}]} as never
 })
})
afterEach(cleanup)
const posts=()=>vi.mocked(request).mock.calls.filter(([p,o])=>p==='/gb28181/devices'&&o?.method==='POST')

async function openRegistration(){
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'大华双目'}})
 fireEvent.click(screen.getByRole('button',{name:'GB/T 28181 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
 const chip=await screen.findByRole('button',{name:'登记此编号'})
 await waitFor(()=>expect(chip).toBeEnabled(),{timeout:8000})
 fireEvent.click(chip)
}

it('has no separate save button: next applies the registration on this page',async()=>{
 await openRegistration()
 expect(screen.queryByRole('button',{name:'保存注册信息'})).toBeNull()
 fireEvent.change(screen.getByLabelText('注册密码'),{target:{value:'teche720'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 await waitFor(()=>expect(posts()).toHaveLength(1),{timeout:8000})
 expect(JSON.parse(posts()[0]![1]!.body as string)).toMatchObject({expectedRevision:7,device:{id,name:'大华双目',enabled:true,password:'teche720'}})
 expect(screen.queryByText('请先保存或取消设备注册信息的修改')).toBeNull()
 expect(await screen.findByText(/设备注册信息已保存/,{},{timeout:8000})).toBeInTheDocument()
},20000)

it('does not save and says what is missing when the registration is incomplete',async()=>{
 await openRegistration()
 fireEvent.change(screen.getByLabelText('注册密码'),{target:{value:'short'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
 expect(await screen.findByText('请填写 20 位国标编号及至少 8 位注册密码',{},{timeout:8000})).toBeInTheDocument()
 expect(posts()).toHaveLength(0)
})

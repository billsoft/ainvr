import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {ChannelWizard} from '@/pages/Channels/ChannelWizard'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const id='34020000001320000001',ch='34020000001310000001',ch2='34020000001310000002'
let saved:boolean,catalogue:unknown[]
beforeEach(()=>{
 saved=false;catalogue=[{id:ch,document:{name:'IPC'},available:true}]
 vi.mocked(request).mockReset().mockImplementation(async(path,options)=>{
  if(options?.method==='POST'&&path==='/gb28181/devices'){saved=true;return {revision:8} as never}
  if(path.startsWith('/gb28181/channel-options'))return {revision:saved?8:7,devices:saved?[{id,name:'大华双目',version:'auto',enabled:true}]:[],items:path.includes('?')?catalogue:[]} as never
  if(path===`/gb28181/devices/${id}/channels`)return {items:catalogue} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'1',realm:'2',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  if(path==='/gb28181/status')return {state:'running',devices:saved?[{id,registered:true}]:[],unknownDevices:saved?[]:[{id,address:'192.168.1.219:5060',lastAttempt:'2026-11-16T03:00:00Z'}]} as never
  return {} as never
 })
})
afterEach(cleanup)

async function register(){
 render(<MemoryRouter><ChannelWizard open mode="create" onClose={()=>{}} onSubmit={()=>{}} onGBSaved={()=>{}}/></MemoryRouter>)
 fireEvent.change(screen.getByTestId('wizard-name'),{target:{value:'大华双目'}})
 fireEvent.click(screen.getByRole('button',{name:'GB/T 28181 摄像头 / NVR'}))
 fireEvent.click(screen.getByTestId('wizard-next'))
 const chip=await screen.findByRole('button',{name:'登记此编号'})
 await waitFor(()=>expect(chip).toBeEnabled(),{timeout:8000})
 fireEvent.click(chip)
 fireEvent.change(screen.getByLabelText('注册密码'),{target:{value:'teche720'}})
 fireEvent.click(screen.getByTestId('wizard-next'))
}

it('one click on next registers the device, waits for its catalogue and moves on when there is one channel',async()=>{
 await register()
 expect(await screen.findByTestId('wizard-submit',{},{timeout:12000})).toBeInTheDocument()
},20000)

it('stays for a choice when the catalogue has several channels',async()=>{
 catalogue=[{id:ch,document:{name:'画面1'},available:true},{id:ch2,document:{name:'画面2'},available:true}]
 await register()
 await screen.findAllByRole('radio',{},{timeout:12000})
 await waitFor(()=>expect(screen.getAllByRole('radio')).toHaveLength(2))
 expect(screen.queryByTestId('wizard-submit')).toBeNull()
},20000)

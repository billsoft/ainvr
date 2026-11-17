import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {request} from '@/api/httpClient'
import {GBSourceFields,type GBSourceDraft} from '@/pages/Channels/GBSourceFields'
vi.mock('@/api/httpClient',()=>({request:vi.fn()}))

const dev='34020000001320000001',a='34020000001310000001',b='34020000001310000002'
let items:unknown[],devices:unknown[]
beforeEach(()=>{
 devices=[{id:dev,name:'大华双目',version:'auto',enabled:true}]
 items=[]
 vi.mocked(request).mockReset().mockImplementation(async(path)=>{
  if(path.startsWith('/gb28181/channel-options'))return {revision:7,devices,items:path.includes('?')?items:[]} as never
  if(path.endsWith('/channels'))return {items} as never
  if(path==='/gb28181/settings')return {revision:1,settings:{enabled:true,serverId:'1',realm:'2',sipPort:5060,advertiseIp:'192.168.100.190'}} as never
  return {state:'running',devices:[],unknownDevices:[]} as never
 })
})
afterEach(()=>{cleanup();vi.clearAllMocks()})
const item=(id:string,extra={})=>({id,document:{name:`画面${id.slice(-1)}`},available:true,enabled:true,transport:'tcp-passive',...extra})
function gb(){
 let draft:GBSourceDraft|undefined
 render(<MemoryRouter><GBSourceFields defaultName="大华双目" onDraft={d=>{draft=d}} onDirty={()=>{}} onBusy={()=>{}}/></MemoryRouter>)
 return ()=>draft!
}

/** There is no device list: an already registered number is that device, and saving shows its catalogue. */
async function registerKnown(draft:()=>GBSourceDraft){
 fireEvent.change(await screen.findByLabelText('设备国标编号（20 位）'),{target:{value:dev}})
 await act(async()=>{await draft().saveRegistration()})
}

it('GB: the only free catalogue channel is selected automatically',async()=>{
 items=[item(a)]
 const draft=gb()
 await registerKnown(draft)
 await waitFor(()=>expect(draft().channelId).toBe(a))
 expect(draft().autoChannel).toBe(true)
})

it('GB: channels already bound to another input are never picked for the user',async()=>{
 items=[item(a,{input_id:'in-1'}),item(b)]
 const draft=gb()
 await registerKnown(draft)
 await waitFor(()=>expect(draft().channelId).toBe(b))
})

it('GB: several free channels stay for the user to choose',async()=>{
 items=[item(a),item(b)]
 const draft=gb()
 await registerKnown(draft)
 await waitFor(()=>expect(draft().deviceId).toBe(dev))
 await screen.findAllByRole('radio')
 expect(draft().channelId).toBe('')
})

it('GB: a channel picked by hand is not marked automatic',async()=>{
 items=[item(a),item(b)]
 const draft=gb()
 await registerKnown(draft)
 fireEvent.click((await screen.findAllByRole('radio'))[1]!)
 await waitFor(()=>expect(draft().channelId).toBe(b))
 expect(draft().autoChannel).toBe(false)
})

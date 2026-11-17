import {cleanup,render,screen,waitFor,within} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {RouterProvider,createMemoryRouter} from 'react-router-dom'
import {mockChannels} from '@/mock/channels'
import {useChannelsStore} from '@/store/channels'
import {request} from '@/api/httpClient'

vi.mock('@/api/httpClient',()=>({request:vi.fn()}))
vi.mock('@/api/channelService',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('@/api/channelService')>()
 return {...actual,channelService:actual.createMockChannelService(mockChannels)}
})
import ChannelsPage from '@/pages/Channels'

const dev='34020000001320000001'
let runtime:Record<string,unknown>
beforeEach(()=>{
 useChannelsStore.setState({channels:[],loading:false,error:null,search:''})
 runtime={state:'running',devices:[{id:dev,registered:false,lastError:'authentication_failed'}],unknownDevices:[{id:'34020000001320000099',address:'192.168.1.50:5060',lastAttempt:'2026-11-16T03:00:00Z'}]}
 vi.mocked(request).mockReset().mockImplementation(async(path)=>{
  if(path==='/gb28181/bindings')return {items:[{input_id:mockChannels[0]!.id,device_id:dev,channel_id:'34020000001310000001'}]} as never
  if(path==='/gb28181/devices')return {revision:3,items:[{id:dev,name:'大华双目',version:'auto',enabled:true,channels:1}]} as never
  if(path==='/gb28181/status')return runtime as never
  return {} as never
 })
})
afterEach(cleanup)
const renderPage=()=>render(<RouterProvider router={createMemoryRouter([{path:'/channels',element:<ChannelsPage/>}],{initialEntries:['/channels']})}/>)

it('shows the device and why it is not streaming on the channel row itself',async()=>{
 renderPage()
 const row=await screen.findByTestId(`channel-row-${mockChannels[0]!.id}`)
 await waitFor(()=>expect(within(row).getByText(/设备 大华双目/)).toBeInTheDocument())
 expect(within(row).getByText(/注册密码不正确/)).toBeInTheDocument()
})

it('has no separate GB device block on the access page',async()=>{
 renderPage()
 await screen.findByTestId(`channel-row-${mockChannels[0]!.id}`)
 expect(screen.queryByRole('region',{name:'国标设备'})).toBeNull()
 expect(screen.queryByText(/收到未登记编号的注册请求/)).toBeNull()
})

it('reads the device state once even while the page is in the background',async()=>{
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>true})
 try{
  renderPage()
  await waitFor(()=>expect(vi.mocked(request).mock.calls.some(([p])=>p==='/gb28181/status')).toBe(true))
 }finally{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false})}
})

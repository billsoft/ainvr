import {afterEach,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {LlmServiceConfigForm} from '../pages/ConfigCenter/LlmServiceConfigForm'
import type {ConfigDocument} from '@/api/configService'
const request=vi.hoisted(()=>vi.fn())
vi.mock('@/api/httpClient',()=>({request}))
afterEach(()=>{cleanup();request.mockReset();vi.unstubAllGlobals()})

it('marks unsaved configuration for the shared navigation guard and clears it when reverted',()=>{
  const {container}=render(<LlmServiceConfigForm onSaveBatch={vi.fn()}/>)
  expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
  fireEvent.click(screen.getByRole('checkbox'))
  expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
})

it('uses only the latest selected image and clears a previous score when its description changes',async()=>{
  const readers:FakeReader[]=[]
  class FakeReader {
    result:string|null=null
    onload:(()=>void)|null=null
    onerror:(()=>void)|null=null
    readAsDataURL(){readers.push(this)}
  }
  vi.stubGlobal('FileReader',FakeReader)
  request.mockResolvedValue({real_score:.8,timing_ms:{total:100},validated:false})
  render(<LlmServiceConfigForm onSaveBatch={vi.fn()}/>)
  fireEvent.click(screen.getByText('试一试 · 不生成告警记录'))
  const input=screen.getByLabelText('JPEG 图片（2:1）')
  fireEvent.change(input,{target:{files:[new File(['first'],'first.jpg',{type:'image/jpeg'})]}})
  fireEvent.change(input,{target:{files:[new File(['second'],'second.jpg',{type:'image/jpeg'})]}})
  const [first,second]=readers
  if(!first||!second)throw new Error('Both selected files must be read')
  act(()=>{second.result='data:image/jpeg;base64,c2Vjb25k';second.onload?.()})
  act(()=>{first.result='data:image/jpeg;base64,Zmlyc3Q=';first.onload?.()})
  fireEvent.click(screen.getByRole('button',{name:'执行复审'}))
  expect(await screen.findByText(/属实分数 0.8000/)).toBeTruthy()
  const call=request.mock.calls.find(c=>c[0]==='/llm/try')
  if(!call)throw new Error('Review request missing')
  expect(JSON.parse(call[1].body).image.jpeg_base64).toBe('c2Vjb25k')
  fireEvent.change(screen.getByLabelText('告警描述'),{target:{value:'新的描述'}})
  expect(screen.queryByText(/属实分数 0.8000/)).toBeNull()
})

it('preserves the independent search task when changing alarm configuration',async()=>{
  const search={enabled:false,aspect_policy:'letterbox',decision_policy:'abc-visible-v1'}
  const document:ConfigDocument={id:1,service:'llm-service',group:'system',name:'settings',createdAt:'',updatedAt:'',config:{
    enabled:false,admin_key:'${secret:llm-service/admin_key}',api_keys:[{name:'console-try',key:'${secret:llm-service/console-try.key}'}],
    tasks:{'alarm-review-zh-v1':{calibration_temperature:1,aspect_policy:'reject'},'search-verify-zh-v1':search}}}
  const save=vi.fn().mockResolvedValue(undefined)
  render(<LlmServiceConfigForm document={document} onSaveBatch={save}/>)
  fireEvent.change(screen.getByLabelText('分数校准温度'),{target:{value:'2'}})
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'保存并应用'}))})
  expect(save).toHaveBeenCalledTimes(1)
  const tasks=save.mock.calls[0]![0][0].config.tasks
  expect(tasks['search-verify-zh-v1']).toEqual(search)
  expect(tasks['alarm-review-zh-v1']).toEqual({calibration_temperature:2,aspect_policy:'reject'})
})

it('offers the installed packages and saves the selected one',async()=>{
  request.mockImplementation(async(url:string)=>url==='/llm/models'?{data:[
    {id:'qwen3vl-4b-review-v3',title:'图片复审模型 · 36 层 · 2560 维',ready:true,ion_bytes_measured:5500000000},
    {id:'qwen3vl-2b-review-v1',title:'视觉语言模型 2B · 图片复审',ready:true,ion_bytes_measured:3000000000},
    {id:'broken',title:'损坏的包',ready:false}]}:undefined)
  const document:ConfigDocument={id:1,service:'llm-service',group:'system',name:'settings',createdAt:'',updatedAt:'',config:{
    enabled:false,admin_key:'${secret:llm-service/admin_key}',api_keys:[{name:'console-try',key:'${secret:llm-service/console-try.key}'}],
    model:{package_id:'qwen3vl-4b-review-v3',load_policy:'resident',ion_reserve_mb:512},
    tasks:{'alarm-review-zh-v1':{calibration_temperature:1,aspect_policy:'reject'}}}}
  const save=vi.fn().mockResolvedValue(undefined)
  const {container}=render(<LlmServiceConfigForm document={document} onSaveBatch={save}/>)
  const select=await screen.findByLabelText('模型包') as HTMLSelectElement
  await waitFor(()=>expect(select.options.length).toBe(2))   // the unready package is not offered
  expect(container.querySelector('[data-unsaved="true"]')).toBeNull()
  expect(screen.getByText(/模型需要约 5.5 GB/)).toBeTruthy()
  fireEvent.change(select,{target:{value:'qwen3vl-2b-review-v1'}})
  expect(container.querySelector('[data-unsaved="true"]')).not.toBeNull()
  expect(screen.getByText(/模型需要约 3.0 GB/)).toBeTruthy()
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'保存并应用'}))})
  expect(save.mock.calls[0]![0][0].config.model).toEqual({package_id:'qwen3vl-2b-review-v1',load_policy:'resident',ion_reserve_mb:512})
})

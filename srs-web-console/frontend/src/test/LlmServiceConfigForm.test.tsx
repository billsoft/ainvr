import {afterEach,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {LlmServiceConfigForm} from '../pages/ConfigCenter/LlmServiceConfigForm'
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
  const call=request.mock.calls[0]
  if(!call)throw new Error('Review request missing')
  expect(JSON.parse(call[1].body).image.jpeg_base64).toBe('c2Vjb25k')
  fireEvent.change(screen.getByLabelText('告警描述'),{target:{value:'新的描述'}})
  expect(screen.queryByText(/属实分数 0.8000/)).toBeNull()
})

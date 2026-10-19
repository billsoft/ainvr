import { useState } from 'react'
import { describe,it,expect,vi } from 'vitest'
import { render,screen,fireEvent } from '@testing-library/react'
import { AnalyticsRuleEditor } from '@/pages/AiChannels/AnalyticsRuleEditor'
import type { AiAnalyticsRule } from '@/types/aiChannel'
vi.mock('@/components/player/VideoPlayer',()=>({VideoPlayer:()=> <div>源流播放器</div>}))
function Editor({initial=[]}:{initial?:AiAnalyticsRule[]}) {
 const [rules,setRules]=useState<AiAnalyticsRule[]>(initial)
 return <><AnalyticsRuleEditor sourceUrl="rtmp://127.0.0.1/live/test" rules={rules} onChange={setRules}/><output data-testid="rules">{JSON.stringify(rules)}</output></>
}
function loadReference() {
 Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:reference'})
 Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=> {}})
 fireEvent.change(screen.getByLabelText(/加载原始画面参考图/),{target:{files:[new File(['image'],'frame.jpg',{type:'image/jpeg'})]}})
 const image=screen.getByAltText('规则参考画面')
 Object.defineProperty(image,'naturalWidth',{value:1920})
 Object.defineProperty(image,'naturalHeight',{value:1080})
 fireEvent.load(image)
 return image
}
describe('rule editor interactions',()=>{
 it('preserves geometry until reference loads and locks again after image failure',()=>{
  const initial=[{id:'门线',type:'line' as const,points:[[0,0],[1,1]] as [number,number][]}]
  render(<Editor initial={initial}/>)
  const before=screen.getByTestId('rules').textContent
  fireEvent.keyDown(screen.getByRole('button',{name:/顶点 1/}),{key:'ArrowRight'})
  fireEvent.click(screen.getByText('重新绘制'))
  expect(screen.getByLabelText('规则类型')).toBeDisabled()
  expect(screen.getByTestId('rules').textContent).toBe(before)
  const image=loadReference()
  expect(screen.getByText('重新绘制')).not.toBeDisabled()
  fireEvent.error(image)
  expect(screen.getByText('重新绘制')).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('button',{name:/顶点 1/}),{key:'ArrowRight'})
  expect(screen.getByTestId('rules').textContent).toBe(before)
  expect(screen.getByText(/参考图加载失败/)).toBeInTheDocument()
 })

 it('adjusts existing vertices by keyboard and clamps to the source frame',()=>{
  render(<Editor initial={[{id:'门线',type:'line',points:[[0,0],[1,1]]}]}/>)
  loadReference()
  const first=screen.getByRole('button',{name:/顶点 1/})
  fireEvent.keyDown(first,{key:'ArrowLeft'})
  fireEvent.keyDown(first,{key:'ArrowUp'})
  expect(JSON.parse(screen.getByTestId('rules').textContent!)[0].points[0]).toEqual([0,0])
  fireEvent.keyDown(first,{key:'ArrowRight',shiftKey:true})
  fireEvent.keyDown(first,{key:'ArrowDown'})
  expect(JSON.parse(screen.getByTestId('rules').textContent!)[0].points).toEqual([[0.01,0.001],[1,1]])
 })
 it('drags a vertex without appending a polygon point and ends on pointer release',()=>{
  vi.stubGlobal('PointerEvent',MouseEvent)
  try {
   render(<Editor initial={[{id:'门区',type:'region',points:[[0,0],[1,0],[1,1]]}]}/>)
   loadReference()
   const area=screen.getByRole('group',{name:'规则绘图区'})
   vi.spyOn(area,'getBoundingClientRect').mockReturnValue({left:10,top:20,width:200,height:100} as DOMRect)
   fireEvent.pointerDown(screen.getByRole('button',{name:/顶点 1/}),{clientX:10,clientY:20})
   fireEvent.pointerMove(area,{clientX:60,clientY:70})
   fireEvent.pointerUp(area)
   fireEvent.click(area,{clientX:60,clientY:70})
   fireEvent.pointerMove(area,{clientX:100,clientY:30})
   expect(JSON.parse(screen.getByTestId('rules').textContent!)[0].points).toEqual([[0.25,0.5],[1,0],[1,1]])
  } finally {vi.unstubAllGlobals()}
 })
 it('adds, edits and deletes a rule',()=>{
  render(<Editor/>)
  fireEvent.click(screen.getByText('添加规则'))
  expect(screen.getByLabelText('规则名称')).toHaveValue('规则1')
  loadReference()
  fireEvent.change(screen.getByLabelText('规则类型'),{target:{value:'dwell'}})
  expect(screen.getByLabelText('停留秒数')).toHaveValue(5)
  fireEvent.change(screen.getByLabelText('规则名称'),{target:{value:'门口停留'}})
  expect(screen.getByRole('button',{name:'门口停留'})).toBeInTheDocument()
  fireEvent.click(screen.getByText('删除规则'))
  expect(screen.queryByLabelText('规则名称')).not.toBeInTheDocument()
 })
 it('does not capture an unready stream or show a false reference image',()=>{
  render(<Editor/>)
  fireEvent.click(screen.getByText('添加规则'))
  fireEvent.click(screen.getByText('打开源流取景'))
  fireEvent.click(screen.getByText('使用当前画面绘制规则'))
  expect(screen.getByText('画面尚未就绪，请等待视频出现后重试')).toBeInTheDocument()
  expect(screen.queryByAltText('规则参考画面')).not.toBeInTheDocument()
 })
})

import {it,expect,vi} from 'vitest'
import {AI_MODEL_PRESETS, type AiAnalysisNode} from '@/types/aiChannel'
import {render,screen,fireEvent} from '@testing-library/react'
import {useState} from 'react'
import {AnalysisPipelineEditor} from '@/pages/AiChannels/AnalysisPipelineEditor'
import {DEFAULT_WIZARD_VALUE,toCreatePatch,validateStep2,buildModelAndPreprocess,wizardModelList,updateWizardModelList,type AiWizardFormValue} from '@/features/aiChannelForm'
import {parseSeiJson} from '@/components/player/seiDetections'
it.each([{classNames: null}, {classNames: undefined}, {classNames: []}])('uses the existing COCO catalog for legacy yolo26x with $classNames', ({classNames}) => {
 const node = structuredClone(wizardModelList(DEFAULT_WIZARD_VALUE)[0]!)
 if (classNames === undefined) Reflect.deleteProperty(node.model, 'class_names')
 else node.model.class_names = classNames
 const value = {...DEFAULT_WIZARD_VALUE, modelProfile: node}
 const original = structuredClone(value)
 const onChange = vi.fn()
 render(<AnalysisPipelineEditor value={value} onChange={onChange}/>)
 expect(screen.getByText(/80 个固定类别/)).toBeInTheDocument()
 expect(screen.queryByText(/^0 个固定类别/)).not.toBeInTheDocument()
 expect(value).toEqual(original)
 expect(onChange).not.toHaveBeenCalled()
})

it.each([
 ['yolo26x', ['custom-a', 'custom-b'], '2 个固定类别'],
 ['yolo26x-face', null, '1 个固定类别'],
 ['imported-detector', ['custom'], '1 个固定类别'],
 ['imported-detector', null, '固定类别（数量未知）'],
 ['imported-detector', [], '固定类别（数量未知）'],
 ['yolo26m', null, '固定类别（数量未知）'],
] as const)('reports the known class catalog or an unknown count for %s (%j)', (name, classes, summary) => {
 const node = structuredClone(wizardModelList(DEFAULT_WIZARD_VALUE)[0]!)
 node.model.name = name
 node.model.class_names = classes ? [...classes] : null
 render(<AnalysisPipelineEditor value={{...DEFAULT_WIZARD_VALUE, modelProfile: node}} onChange={vi.fn()}/>)
 expect(screen.getByText(text => text.startsWith(summary))).toBeInTheDocument()
 expect(screen.queryByText(/^0 个固定类别/)).not.toBeInTheDocument()
})

it('keeps open vocabulary summaries based on configured prompts', () => {
 const value = {...DEFAULT_WIZARD_VALUE, modelPreset: 'yoloe-26x-1' as const,
  prompts: [{description: 'car', label_id: 'car', label_name: '车辆'}]}
 render(<AnalysisPipelineEditor value={value} onChange={vi.fn()}/>)
 expect(screen.getByText(/1 个识别目标/)).toBeInTheDocument()
 expect(screen.queryByText(/固定类别/)).not.toBeInTheDocument()
})

it('adds and removes a real model in the shared channel configuration',()=>{
 let latest:AiWizardFormValue=DEFAULT_WIZARD_VALUE
 function Harness(){const [value,setValue]=useState<AiWizardFormValue>(DEFAULT_WIZARD_VALUE);latest=value;return <AnalysisPipelineEditor value={value} onChange={setValue}/>}
 const uuid=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>{throw Error('not available on HTTP')});
 render(<Harness/>);fireEvent.change(screen.getByLabelText('待添加模型'),{target:{value:'plate-recognition'}});fireEvent.click(screen.getByText('添加模型'))
 const patch=toCreatePatch(latest);expect(patch.analysis_pipeline?.nodes[0]?.model.adapter).toBe('plate_bpu');expect(patch.model?.adapter).toBe('yolo26_bpu')
 expect(latest.analysisPipeline?.execution).toBe('serial') // Execution is edited by the parent wizard's common settings.
 fireEvent.click(screen.getByRole('button',{name:'移除 车牌检测与识别'}));expect(toCreatePatch(latest).analysis_pipeline?.nodes).toEqual([]);uuid.mockRestore()
})
it('requires valid descriptions for extra open-vocabulary nodes',()=>{
 const extra=buildModelAndPreprocess('yoloe-26x-1',DEFAULT_WIZARD_VALUE)
 const v={...DEFAULT_WIZARD_VALUE,analysisPipeline:{execution:'serial' as const,nodes:[{id:'extra',...extra,postprocess:{conf_threshold:.25,iou_threshold:.45,max_detections:300}}]}}
 expect(validateStep2(v).analysisPipeline).toBeTruthy()
 expect(validateStep2({...v,modelPreset:'locateanything-3b'}).analysisPipeline).toBeTruthy()
})
it('SEI keeps attributes attached to the exact frame and never invents absent values',()=>{
 const f=parseSeiJson(JSON.stringify({pts:123,det:[{c:80,n:'license_plate',p:.9,l:'node:plate:plate',b:[10,20,30,40],src:'plate',a:{plate_text:{type:'string',value:'京A12345',status:'candidate'},plate_color:{type:'enum',value:null}}}]}))!
 expect(f.ptsNs).toBe(123);expect(f.detections[0]!.model_extra?.attributes?.plate_text?.value).toBe('京A12345');expect(f.detections[0]!.model_extra?.attributes?.plate_color?.value).toBeNull()
 const old=parseSeiJson('{"pts":5,"det":[{"c":0,"n":"person","b":[1,2,3,4]}]}')!;expect(old.detections[0]!.model_extra).toBeUndefined()
})

it('reorders peers, deletes the original model and preserves remaining configuration and IDs',()=>{
 const face:AiAnalysisNode={id:'face',...buildModelAndPreprocess('yolo26x-face',DEFAULT_WIZARD_VALUE),postprocess:{conf_threshold:.42,iou_threshold:.45,max_detections:120}}
 face.model.path='models/custom-face.hbm'
 let value=updateWizardModelList(DEFAULT_WIZARD_VALUE,[...wizardModelList(DEFAULT_WIZARD_VALUE),face])
 value=updateWizardModelList(value,[face,wizardModelList(value)[0]!])
 expect(value.analysisPipeline?.order).toEqual(['face','primary']);expect(value.modelPreset).toBe(DEFAULT_WIZARD_VALUE.modelPreset)
 value=updateWizardModelList(value,[face]);const patch=toCreatePatch(value)
 expect(patch.analysis_pipeline?.root_id).toBe('face');expect(patch.analysis_pipeline?.nodes).toEqual([]);expect(patch.model?.path).toBe('models/custom-face.hbm');expect(patch.postprocess?.conf_threshold).toBe(.42);expect(wizardModelList(value).map(n=>n.id)).toEqual(['face'])
 expect(()=>updateWizardModelList(value,[])).toThrow(/至少一个/)
})
it('offers touch and keyboard sorting without privileged model removal',()=>{
 let latest=DEFAULT_WIZARD_VALUE
 function Harness(){const [value,setValue]=useState(DEFAULT_WIZARD_VALUE);latest=value;return <AnalysisPipelineEditor value={value} onChange={setValue}/>}
 render(<Harness/>);fireEvent.click(screen.getByText('添加模型'))
 const title=screen.getAllByRole('button',{name:/上移/})[1]!.getAttribute('aria-label')!.slice(3)
 fireEvent.click(screen.getByRole('button',{name:'上移 '+title}));expect(latest.analysisPipeline?.order?.[1]).toBe('primary')
 fireEvent.click(screen.getAllByRole('button',{name:/移除/})[1]!);expect(latest.analysisPipeline?.root_id).not.toBe('primary');expect(screen.getByRole('button',{name:/移除/})).toBeDisabled()
})

it('new open-vocabulary peers stay incomplete until their separate configuration is applied',()=>{
 let latest=DEFAULT_WIZARD_VALUE
 function Harness(){const [value,setValue]=useState(DEFAULT_WIZARD_VALUE);latest=value;return <AnalysisPipelineEditor value={value} onChange={setValue}/>}
 render(<Harness/>);fireEvent.change(screen.getByLabelText('待添加模型'),{target:{value:'yoloe-26x-1'}});fireEvent.click(screen.getByText('添加模型'))
 expect(screen.queryByLabelText('识别描述 1')).not.toBeInTheDocument()
 expect(screen.getByText(/待完善/)).toBeInTheDocument()
 expect(wizardModelList(latest)[1]!.model.prompts?.[0]?.description).toBe('')
 expect(validateStep2(latest).analysisPipeline).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:`配置 ${AI_MODEL_PRESETS['yoloe-26x-1'].displayName}`}))
 expect(screen.getByLabelText('yoloe-26x-1 IoU 阈值')).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('识别描述 1'),{target:{value:'car'}})
 fireEvent.click(screen.getByRole('button',{name:'应用到通道草稿'}))
 expect(screen.getByRole('alert')).toHaveTextContent(/标签名称/)
 expect(validateStep2(latest).analysisPipeline).toBeTruthy()
 fireEvent.change(screen.getByLabelText('标签名称 1'),{target:{value:'车辆'}})
 fireEvent.click(screen.getByRole('button',{name:'应用到通道草稿'}))
 expect(validateStep2(latest)).toEqual({})
 expect(toCreatePatch(latest).analysis_pipeline?.nodes[0]?.model.prompts?.[0]).toEqual({description:'car',label_id:'target',label_name:'车辆'})
})

it('rejects an oversized combined budget before submission and accepts 4 bounded peers',()=>{
 const member=buildModelAndPreprocess('plate-recognition',DEFAULT_WIZARD_VALUE)
 const nodes=['a','b','c'].map(id=>({id,...member,postprocess:{conf_threshold:.25,iou_threshold:.45,max_detections:300}}))
 const v={...DEFAULT_WIZARD_VALUE,maxDetections:300,analysisPipeline:{execution:'serial' as const,nodes}}
 expect(validateStep2(v).analysisPipeline).toMatch(/1000/)
 expect(validateStep2({...v,maxDetections:250,analysisPipeline:{...v.analysisPipeline,nodes:nodes.map(n=>({...n,postprocess:{...n.postprocess,max_detections:250}}))}}).analysisPipeline).toBeUndefined()
})


it('adds four legal models with a remaining budget of 100 and stable existing parameters', () => {
 let latest = DEFAULT_WIZARD_VALUE
 function Harness() {
  const [value, setValue] = useState(DEFAULT_WIZARD_VALUE)
  latest = value
  return <AnalysisPipelineEditor value={value} onChange={setValue} />
 }
 render(<Harness />)
 for (const key of ['yolo26x-face', 'plate-recognition', 'fire-smoke-yolo26n']) {
  fireEvent.change(screen.getByLabelText('待添加模型'), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
 }
 const nodes = wizardModelList(latest)
 expect(nodes).toHaveLength(4)
 expect(new Set(nodes.map(n => n.id)).size).toBe(4)
 expect(nodes.map(n => n.postprocess.max_detections)).toEqual([300, 300, 300, 100])
 expect(validateStep2(latest)).toEqual({})
 expect(toCreatePatch(latest).analysis_pipeline?.nodes).toHaveLength(3)
 expect(screen.queryByRole('button', { name: '添加模型' })).not.toBeInTheDocument()
 expect(screen.queryByLabelText(/检测置信度/)).not.toBeInTheDocument()
})

it('configures by stable ID after sorting and preserves that configuration when the original root is removed', () => {
 let latest = DEFAULT_WIZARD_VALUE
 function Harness() {
  const [value, setValue] = useState(DEFAULT_WIZARD_VALUE)
  latest = value
  return <AnalysisPipelineEditor value={value} onChange={setValue} />
 }
 render(<Harness />)
 fireEvent.click(screen.getByRole('button', { name: '添加模型' }))
 const original = structuredClone(wizardModelList(latest))
 const face = original[1]!
 const title = AI_MODEL_PRESETS['yolo26x-face'].displayName
 fireEvent.click(screen.getByRole('button', { name: `上移 ${title}` }))
 expect(wizardModelList(latest).map(n => n.id)).toEqual([face.id, 'primary'])
 fireEvent.click(screen.getByRole('button', { name: `配置 ${title}` }))
 fireEvent.change(screen.getByLabelText(/检测置信度/), { target: { value: '.62' } })
 fireEvent.click(screen.getByRole('button', { name: '应用到通道草稿' }))
 expect(wizardModelList(latest)[1]).toEqual(original[0])
 const configured = structuredClone(wizardModelList(latest)[0]!)
 expect(configured).toMatchObject({ id: face.id, postprocess: { conf_threshold: .62 } })
 fireEvent.click(screen.getByRole('button', { name: `移除 ${AI_MODEL_PRESETS[DEFAULT_WIZARD_VALUE.modelPreset].displayName}` }))
 expect(wizardModelList(latest)).toEqual([configured])
 expect(latest.analysisPipeline?.root_id).toBe(face.id)
 expect(toCreatePatch(latest).postprocess?.conf_threshold).toBe(.62)
 expect(screen.getByRole('button', { name: `移除 ${title}` })).toBeDisabled()
 fireEvent.click(screen.getByRole('button', { name: `配置 ${title}` }))
 expect(screen.getByLabelText(/检测置信度/)).toHaveValue(.62)
})

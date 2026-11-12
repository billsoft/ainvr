import {it,expect,vi} from 'vitest'
import type {AiAnalysisNode} from '@/types/aiChannel'
import {render,screen,fireEvent} from '@testing-library/react'
import {useState} from 'react'
import {AnalysisPipelineEditor} from '@/pages/AiChannels/AnalysisPipelineEditor'
import {DEFAULT_WIZARD_VALUE,toCreatePatch,validateStep2,buildModelAndPreprocess,wizardModelList,updateWizardModelList,type AiWizardFormValue} from '@/features/aiChannelForm'
import {parseSeiJson} from '@/components/player/seiDetections'
it('adds and removes a real model in the shared channel configuration',()=>{
 let latest:AiWizardFormValue=DEFAULT_WIZARD_VALUE
 function Harness(){const [value,setValue]=useState<AiWizardFormValue>(DEFAULT_WIZARD_VALUE);latest=value;return <AnalysisPipelineEditor value={value} onChange={setValue}/>}
 const uuid=vi.spyOn(crypto,'randomUUID').mockImplementation(()=>{throw Error('not available on HTTP')});
 render(<Harness/>);fireEvent.change(screen.getByLabelText('待添加模型'),{target:{value:'plate-recognition'}});fireEvent.click(screen.getByText('添加模型'))
 const patch=toCreatePatch(latest);expect(patch.analysis_pipeline?.nodes[0]?.model.adapter).toBe('plate_bpu');expect(patch.model?.adapter).toBe('yolo26_bpu')
 fireEvent.change(screen.getByLabelText('模型执行方式'),{target:{value:'parallel'}});expect(latest.analysisPipeline?.execution).toBe('parallel')
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

it('new open-vocabulary peers expose their prompt and NMS settings immediately',()=>{
 function Harness(){const [value,setValue]=useState(DEFAULT_WIZARD_VALUE);return <AnalysisPipelineEditor value={value} onChange={setValue}/>}
 render(<Harness/>);fireEvent.change(screen.getByLabelText('待添加模型'),{target:{value:'yoloe-26x-1'}});fireEvent.click(screen.getByText('添加模型'))
 expect(screen.getByLabelText('识别描述 1')).toBeInTheDocument();expect(screen.getByLabelText('yoloe-26x-1 IoU 阈值')).toBeInTheDocument()
})

it('rejects an oversized combined budget before submission and accepts 4 bounded peers',()=>{
 const member=buildModelAndPreprocess('plate-recognition',DEFAULT_WIZARD_VALUE)
 const nodes=['a','b','c'].map(id=>({id,...member,postprocess:{conf_threshold:.25,iou_threshold:.45,max_detections:300}}))
 const v={...DEFAULT_WIZARD_VALUE,maxDetections:300,analysisPipeline:{execution:'serial' as const,nodes}}
 expect(validateStep2(v).analysisPipeline).toMatch(/1000/)
 expect(validateStep2({...v,maxDetections:250,analysisPipeline:{...v.analysisPipeline,nodes:nodes.map(n=>({...n,postprocess:{...n.postprocess,max_detections:250}}))}}).analysisPipeline).toBeUndefined()
})

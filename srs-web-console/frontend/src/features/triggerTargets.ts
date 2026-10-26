import {AI_MODEL_PRESETS,isOpenVocabularyPreset,type AiModelPresetKey} from '@/types/aiChannel'
import type {TriggerDefinitionInput,TriggerTargetModel} from './alarmDefinitions'
import {sameLabel,type TriggerLabel} from './alarmTriggers'
// Verified against ai-service/models/derived/s100p/yolo26x.hbm.ainvr.json.
// Runtime binding still validates every selected label against the loaded model.
const cocoNames=["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"] as const
export function targetModel(key:AiModelPresetKey):TriggerTargetModel {
 const m=AI_MODEL_PRESETS[key].model
 return {name:m.name,adapter:m.adapter,mode:isOpenVocabularyPreset(key)?'open':'fixed'}
}
export function fixedTargets(key:AiModelPresetKey):TriggerLabel[] {
 const names=key==='yolo26x'?cocoNames:AI_MODEL_PRESETS[key].model.class_names??[]
 return names.map((name,index)=>({label_id:`class:${index}`,name}))
}
export function targetModelMatches(a:TriggerTargetModel|undefined,b:TriggerTargetModel|undefined){
 return !a||!!b&&a.name===b.name&&a.adapter===b.adapter&&a.mode===b.mode
}
export function triggerTargetsMatch(trigger:Pick<TriggerDefinitionInput,'target_model'|'labels'>,source:{target_model?:TriggerTargetModel;labels:TriggerLabel[]}){
 return targetModelMatches(trigger.target_model,source.target_model)&&trigger.labels.every(l=>source.labels.some(s=>sameLabel(l,s)))
}
export function targetError(value:Pick<TriggerDefinitionInput,'target_model'|'labels'>){
 if(!value.labels.length)return '至少选择一个检测目标'
 if(new Set(value.labels.map(l=>l.label_id)).size!==value.labels.length)return '标签 ID 不能重复'
 if(value.labels.some(l=>!l.name.trim()||!l.label_id.match(/^[a-zA-Z0-9_.:-]{1,128}$/)))return '请填写显示名称和有效的标签 ID（英文、数字、点、冒号、短横线或下划线）'
 if(value.target_model?.mode==='open'&&value.labels.some(l=>!l.description?.trim()||l.description.length>160||l.description.includes('<|')))return '请填写与 AI 通道一致的识别描述，最多160个字符'
 return ''
}

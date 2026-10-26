import type {TriggerDefinition,TriggerDefinitionInput} from './alarmDefinitions'

// Preserve the existing caller text and thresholds. UI simplification must not
// silently change a validated model prompt or migrate an existing review policy.
export const DEFAULT_REVIEW_DESCRIPTION='确认截图中的目标与检测类别相符'
export const defaultTriggerReview=()=>({enabled:true,description:DEFAULT_REVIEW_DESCRIPTION,reject_below:0.05,approve_above:0.95})
export function triggerDefinitionInput(t:TriggerDefinition):TriggerDefinitionInput {
 return structuredClone({trigger_id:t.trigger_id,name:t.name,behavior:t.behavior,labels:t.labels,
  ...(t.target_model?{target_model:t.target_model}:{}),duration_ms:t.duration_ms,
  ...(t.approach_width_percent!==undefined?{approach_width_percent:t.approach_width_percent}:{}),
  alarm_enabled:t.alarm_enabled,state:t.state,schedule:t.schedule,...(t.review?{review:t.review}:{})})
}

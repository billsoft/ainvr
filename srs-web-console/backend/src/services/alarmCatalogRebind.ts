import type {AssignmentSource} from '../store/alarmTriggerDefinition.js';

/** Only a directory change may be repaired automatically. A camera, coordinate,
 * prompt or selected-label change still requires an operator to re-arm. */
export function catalogRebindAllowed(binding:any, definition:any, previous:any, source:AssignmentSource):boolean {
  const old=previous?.source_binding;
  if(!old||binding.processor_id!==source.channel_id||binding.input_stream_id!==source.input_stream_id||
    binding.geometry_revision!==source.geometry_revision||old.geometry_revision!==source.geometry_revision||
    old.input_stream_id!==source.input_stream_id||old.stream_fingerprint!==source.stream_fingerprint||
    old.width!==source.width||old.height!==source.height||old.label_map_version!==binding.label_map_version||
    !source.observed_at||!Number.isFinite(Date.parse(source.observed_at))||
    Date.parse(source.observed_at)<Date.parse(old.not_before))return false;
  const expected=definition.target_model;
  if(expected&&(!source.target_model||expected.name!==source.target_model.name||expected.adapter!==source.target_model.adapter||expected.mode!==source.target_model.mode))return false;
  // Historical counters have no prompt contract. Never infer prompt equivalence
  // from a matching display name; only empty descriptions can migrate there.
  return Array.isArray(definition.labels)&&definition.labels.length>0&&definition.labels.every((label:any)=>
    source.labels.some(current=>current.label_id===label.label_id&&
      (current.name||current.description||current.label_id)===label.name&&
      (current.description??'')===(label.description??'')));
}

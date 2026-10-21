import type {AlarmSchedule} from './alarmSchedule'
import type {TriggerBehavior,TriggerLabel} from './alarmTriggers'
export interface TriggerDefinitionInput {
 trigger_id:string;name:string;behavior:TriggerBehavior;labels:TriggerLabel[];
 duration_ms:number;approach_width_percent?:number;alarm_enabled:boolean;
 state:'draft'|'enabled'|'paused'|'archived';schedule:AlarmSchedule
}
export interface TriggerDefinition extends TriggerDefinitionInput {
 version:number
 migration_review?:{required:boolean;reason:string;from?:string}
 usages?:{assignment_id:string;source_id:string;processor_id:string;zone_name:string|null}[]
}

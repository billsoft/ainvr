import type {AlarmEvent} from '@/api/alarmEventService'
export const PLAYBACK_MARGIN_MS=15000
export function playbackRange(alarm:AlarmEvent){
 const occurred=Date.parse(alarm.occurred_at),last=Date.parse(alarm.last_seen_at)
 if(!Number.isFinite(occurred)||!Number.isFinite(last)||last<occurred)return null
 const evidence=alarm.analysis_evidence
 const starts=[evidence?.started_at,...(alarm.review?.frames??[]).map(f=>f.captured_at)]
  .map(v=>v?Date.parse(v):NaN).filter(v=>Number.isFinite(v)&&v<=last)
 const legacy=alarm.activity_started_at?Date.parse(alarm.activity_started_at):NaN
 const start=Math.min(occurred,...starts,...(!starts.length&&Number.isFinite(legacy)&&legacy<=occurred?[legacy]:[]))
 return {from:start-PLAYBACK_MARGIN_MS,to:last+PLAYBACK_MARGIN_MS}
}
/** Source camera timestamps, never the delayed AI output. */
export function playbackHref(alarm:AlarmEvent){
 const range=playbackRange(alarm)
 return alarm.input_stream_id&&range?`/playback/${encodeURIComponent(alarm.input_stream_id)}?from=${range.from}&to=${range.to}`:null
}
export function keyframePlaybackHref(alarm:AlarmEvent,capturedAt:string){
 const at=Date.parse(capturedAt)
 return alarm.input_stream_id&&Number.isFinite(at)?`/playback/${encodeURIComponent(alarm.input_stream_id)}?from=${at-PLAYBACK_MARGIN_MS}&to=${at+PLAYBACK_MARGIN_MS}`:null
}

import type {AlarmEvent} from '@/api/alarmEventService'
import { EVIDENCE_PRE_ROLL_MS, recordingPlaybackHref } from './playbackNavigation'
export const PLAYBACK_MARGIN_MS=EVIDENCE_PRE_ROLL_MS
export function playbackRange(alarm:AlarmEvent){
 const occurred=Date.parse(alarm.occurred_at),last=Date.parse(alarm.last_seen_at)
 if(!Number.isFinite(occurred)||!Number.isFinite(last)||last<occurred)return null
 const evidence=alarm.analysis_evidence
 const starts=[evidence?.started_at,...(alarm.review?.frames??[]).map(f=>f.captured_at)]
  .map(v=>v?Date.parse(v):NaN).filter(v=>Number.isFinite(v)&&v<=last)
 const legacy=alarm.activity_started_at?Date.parse(alarm.activity_started_at):NaN
 const start=Math.min(occurred,...starts,...(!starts.length&&Number.isFinite(legacy)&&legacy<=occurred?[legacy]:[]))
 return {from:start-PLAYBACK_MARGIN_MS,to:last+15000}
}
/** Replay the owning AI output; never silently redirect to its input. */
export function playbackHref(alarm:AlarmEvent){
 const range=playbackRange(alarm)
 return range?recordingPlaybackHref(alarm.playback_stream_id,range.from,range.to):null
}
export function keyframePlaybackHref(alarm:AlarmEvent,capturedAt:string){
 const at=Date.parse(capturedAt)
 return recordingPlaybackHref(alarm.playback_stream_id,at-PLAYBACK_MARGIN_MS,at+15000)
}

/** Exact processor identity is essential when several processors share an input. */
export function resolveAlarmOutput(alarm:Pick<AlarmEvent,'channel_id'|'input_stream_id'>,
 ai:{id:string;config:{stream:{url:string};publish:{effective_target_url?:string;target_url?:string|null}}}|null,
 channels:{id:string;upstream:{app:string;stream:string}}[]):string|undefined {
 if(!ai||ai.id!==alarm.channel_id)return undefined
 const key=(value:string)=>{try{return new URL(value).pathname}catch{return null}}
 const input=channels.find(c=>c.id===alarm.input_stream_id)
 if(!input||key(ai.config.stream.url)!==`/${input.upstream.app}/${input.upstream.stream}`)return undefined
 const output=key(ai.config.publish.effective_target_url||ai.config.publish.target_url||'')
 const matches=channels.filter(c=>c.id!==input.id&&`/${c.upstream.app}/${c.upstream.stream}`===output)
 return matches.length===1?matches[0]!.id:undefined
}
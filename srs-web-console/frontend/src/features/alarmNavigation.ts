import type {AlarmEvent} from '@/api/alarmEventService'
export const PLAYBACK_MARGIN_MS=15000
/** Use the original input camera and a bounded context window, never the delayed AI stream. */
export function playbackHref(alarm:AlarmEvent){
 if(!alarm.input_stream_id)return null
 const occurred=Date.parse(alarm.occurred_at),last=Date.parse(alarm.last_seen_at)
 if(!Number.isFinite(occurred)||!Number.isFinite(last)||last<occurred)return null
 return `/playback/${encodeURIComponent(alarm.input_stream_id)}?from=${occurred-PLAYBACK_MARGIN_MS}&to=${last+PLAYBACK_MARGIN_MS}`
}

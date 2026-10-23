import {describe,it,expect} from 'vitest'
import {playbackRange,playbackHref,keyframePlaybackHref} from '@/features/alarmNavigation'
import type {AlarmEvent} from '@/api/alarmEventService'
const alarm={input_stream_id:'camera / 1',occurred_at:'2026-10-23T10:10:00Z',last_seen_at:'2026-10-23T10:10:05Z',activity_started_at:'2026-10-23T09:00:00Z'} as AlarmEvent
describe('alarm recording navigation',()=>{
 it('uses behavior start for a long traversal rather than a late trigger or unrelated early activity',()=>{
 const row={...alarm,analysis_evidence:{source:{width:100,height:100},started_at:'2026-10-23T10:00:00Z'}}
 expect(playbackRange(row)?.from).toBe(Date.parse('2026-10-23T09:59:45Z'))
 expect(playbackHref(row)).toContain('camera%20%2F%201')
 })
 it('uses timestamped keyframes and falls back to activity for historical records',()=>{
 expect(playbackRange(alarm)?.from).toBe(Date.parse(alarm.activity_started_at!)-15000)
 const row={...alarm,review:{state:'queued',frames:[{captured_at:'2026-10-23T10:01:00Z'}]}} as AlarmEvent
 expect(playbackRange(row)?.from).toBe(Date.parse('2026-10-23T10:00:45Z'))
 })
 it('provides per-frame context and refuses invalid timestamps or missing source',()=>{
 expect(keyframePlaybackHref(alarm,'2026-10-23T10:00:00Z')).toContain('from='+ (Date.parse('2026-10-23T10:00:00Z')-15000))
 expect(keyframePlaybackHref(alarm,'bad')).toBeNull()
 expect(playbackHref({...alarm,input_stream_id:undefined})).toBeNull()
 expect(playbackHref({...alarm,last_seen_at:'bad'})).toBeNull()
 })
})

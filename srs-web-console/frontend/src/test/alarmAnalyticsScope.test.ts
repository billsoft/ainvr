import {expect,it} from 'vitest'
import {alarmInScope,parseAlarmListScope} from '@/pages/AlarmCenter/alarmListScope'
import type {AlarmEvent} from '@/api/alarmEventService'
const query={from:'2026-10-30T00:00:00.000Z',to:'2026-10-31T00:00:00.000Z',timezone:'Asia/Shanghai',bucket:'hour'}
const scope=(extra:Record<string,unknown>={})=>parseAlarmListScope('?status=all&analytics_scope='+encodeURIComponent(JSON.stringify({...query,...extra})))
const alarm={alarm_id:'a',occurred_at:'2026-10-30T02:00:00.000Z',channel_id:'c',behavior:'region_enter',trigger_id:'one',rule:{id:'r'},handling:{state:'acknowledged',reviewed_by_kind:'human',disposition:'false_positive'},stages:[{zone_id:'z1',trigger_id:'one'},{zone_id:'z2',trigger_id:'two'}]} as AlarmEvent
it('restores a bounded all-location analysis without weakening old scope validation',()=>{
 expect(scope()).toMatchObject({kind:'valid',locations:[],analytics:{timezone:'Asia/Shanghai'}})
 expect(parseAlarmListScope('?status=all&from='+query.from+'&to='+query.to)).toEqual({kind:'invalid'})
 for(const patch of [{locations:[]},{weekday:7},{hour:24},{timezone:'bad/zone'},{audit:'resolved'},{association:'unknown'},{unexpected:true},{to:'2026-12-01T00:00:00Z'}])expect(scope(patch)).toEqual({kind:'invalid'})
})
it('keeps paired location and trigger on the same stage in polling reconciliation',()=>{
 const unrelated=scope({locations:[{channel_id:'c',zone_id:'z1'}],trigger_id:'two'})
 const related=scope({locations:[{channel_id:'c',zone_id:'z2'}],trigger_id:'two'})
 if(unrelated.kind!=='valid'||related.kind!=='valid')throw Error('Invalid fixture')
 expect(alarmInScope(alarm,unrelated)).toBe(false)
 expect(alarmInScope(alarm,related)).toBe(true)
 expect(alarmInScope({...alarm,channel_id:'other'},related)).toBe(false)
})
it('uses primary behavior and explicit human verdict, never any historical stage or unknown reviewer',()=>{
 const selected=scope({audit:'human_false_positive',primary_type:'region_enter'})
 if(selected.kind!=='valid')throw Error('Invalid fixture')
 expect(alarmInScope(alarm,selected)).toBe(true)
 expect(alarmInScope({...alarm,handling:{...alarm.handling,reviewed_by_kind:'ai'}},selected)).toBe(false)
 expect(alarmInScope({...alarm,behavior:'region_traverse'},selected)).toBe(false)
})
it('matches weekday and hour in the analysis timezone and excludes the range end',()=>{
 const selected=scope({weekday:4,hour:10})
 if(selected.kind!=='valid')throw Error('Invalid fixture')
 expect(alarmInScope(alarm,selected)).toBe(true)
 expect(alarmInScope({...alarm,occurred_at:'2026-10-30T03:00:00Z'},selected)).toBe(false)
 expect(alarmInScope({...alarm,occurred_at:query.to},selected)).toBe(false)
})
it('keeps unassociated alarms separate and fails closed for duplicate or mixed scope encodings',()=>{
 const selected=scope({association:'unassociated'})
 if(selected.kind!=='valid')throw Error('Invalid fixture')
 expect(alarmInScope(alarm,selected)).toBe(false)
 expect(alarmInScope({...alarm,stages:[]},selected)).toBe(true)
 const encoded=encodeURIComponent(JSON.stringify(query))
 expect(parseAlarmListScope('?status=all&from=x&analytics_scope='+encoded)).toEqual({kind:'invalid'})
 expect(parseAlarmListScope('?status=all&analytics_scope='+encoded+'&analytics_scope='+encoded)).toEqual({kind:'invalid'})
})

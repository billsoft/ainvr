import assert from 'node:assert/strict';
import {heatFrame,heatRule,heatStep,origin} from '../alarm-service/test/region-heat-fixtures.mjs';
import {dwellStep} from '../alarm-service/src/dwell-visits.mjs';
import {DwellQuery} from '../alarm-service/src/dwell-query.mjs';
import {ObservationConsumer} from '../alarm-service/src/ingestion.mjs';
let facts=[];
for(const [session,map] of [['old','old-model'],['new','new-model']]) {
 let state;
 for(let i=1;i<=3;i++) {
  const f=heatFrame(i,{session,time:i*100,x:i===3?.9:.4,label:'class:0'});f.model.label_map_version=map;
  const r=dwellStep(state,f,[{...heatRule,label_ids:['class:0'],label_map_version:map}]);state=r.state;facts.push(...r.facts);
 }
}
assert.equal(facts.length,2);assert(facts.every(f=>f.label_map_version===undefined));
const query=new DwellQuery({collection:name=>name==='region_dwell_visits'?{find:()=>({sort(){return this},limit(){return this},async toArray(){return facts}}),findOne:async()=>null}:{findOne:async()=>null}});
const result=await query.query({channel_id:'c',zone_id:'z',label_ids:['class:0'],from:new Date(origin).toISOString(),to:new Date(origin+60000).toISOString()});
console.log('MODEL_VERSION_LOST',JSON.stringify({factCount:facts.length,storedLabelMaps:facts.map(f=>f.label_map_version??null),mergedMs:result.observed_ms,sampleLabels:result.samples.map(s=>s.label_id)}));
let alarms=0,checkpoints=0;
const repo={checkpoints:{findOneAndUpdate:async()=>{checkpoints++;return {}}},db:{collection:()=>({updateOne:async()=>{throw Error('derived write unavailable')}})},behaviors:{insert:async()=>{alarms++;return 'b'}},insert:async()=>{},flow:{record:async()=>{}}};
const consumer=new ObservationConsumer(repo);
await assert.rejects(consumer.finish({pending:{dwell_facts:[facts[0]],events:[{}]}},()=>({})),/derived write unavailable/);
console.log('OPTIONAL_WRITE_BLOCKS_ALARMS',JSON.stringify({alarmsReached:alarms,checkpointsReached:checkpoints}));
let cp,recorded=0,atHour=0,issues=[];
for(let seq=0;seq<=3605;seq++) {const r=heatStep(cp,heatFrame(seq,{time:seq*1000}));cp=r.checkpoint;recorded+=r.facts.reduce((s,f)=>s+f.observed_ms,0);if(seq===3600)atHour=recorded;issues=r.issues;}
const open=Object.values(cp.region_heat.grids??{}).reduce((s,g)=>s+g.observed_ms,0);
console.log('LONG_VISIT_HEAT_STOPS',JSON.stringify({eligibleSpanMs:3605000,recordedPlusOpenMs:recorded+open,atHour,sealedAfterHour:recorded-atHour,blocked:Object.values(cp.dwell.visits)[0]?._blocked,lastIssues:issues}));

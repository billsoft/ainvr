import test from 'node:test';
import assert from 'node:assert/strict';
import {ObservationConsumer} from '../src/ingestion.mjs';
import {DwellQuery} from '../src/dwell-query.mjs';
import {dwellStep} from '../src/dwell-visits.mjs';
import {heatFrame,heatRule,heatStep} from './region-heat-fixtures.mjs';

test('optional batch failure commits an explicit gap after base alarms and preserves replay identity',async()=>{
  const calls=[];let saved;
  const repo={db:{collection:()=>({bulkWrite:async()=>{throw Error('disk unavailable')}})},
    behaviors:{insert:async()=>{calls.push('behavior');return 'b'}},insert:async()=>calls.push('alarm'),
    flow:{record:async()=>calls.push('coverage')},checkpoints:{findOneAndUpdate:async(q,u)=>{saved=u.$set;calls.push('checkpoint');return saved}}};
  const pending={fingerprint:'stable',offset:'7',checkpoint:{},events:[{rule:{snapshot:{}}}],issues:[],coverage:[],
    dwell_facts:[{_id:'d',started_at:'2026-01-01T00:00:00Z',ended_at:'2026-01-01T00:00:01Z'}],
    heat_facts:[{_id:'h',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'}]};
  await new ObservationConsumer(repo).finish({pending},()=>({}));
  assert.deepEqual(calls,['behavior','alarm','coverage','checkpoint']);
  assert.equal(saved.offset,'7');assert.equal(saved.pending,null);
  assert.equal(saved.checkpoint.dwell_gaps[0].reason,'dwell_write_failed');
  assert.equal(saved.checkpoint.region_heat.gaps[0].to,'2026-01-01T00:01:00.000Z');
  assert.ok(saved.last_issues.includes('heat_write_failed'));
});
test('hung optional writer has a bounded deadline and commits a conservative gap',async()=>{
  let saved;const start=performance.now();
  const repo={db:{collection:()=>({bulkWrite:()=>new Promise(()=>{})})},checkpoints:{findOneAndUpdate:async(q,u)=>(saved=u.$set)}};
  await new ObservationConsumer(repo).finish({pending:{offset:'8',fingerprint:'x',checkpoint:{},events:[],issues:[],dwell_facts:[{_id:'x',started_at:'2026-01-01T00:00:00Z',ended_at:'2026-01-01T00:00:01Z'}]}},()=>({}));
  assert.ok(performance.now()-start<3000);assert.equal(saved.offset,'8');assert.equal(saved.checkpoint.dwell_gaps.length,1);
});
test('long visit quota never truncates source heat; coast still contributes no target-time',()=>{
  let a=heatStep(null,heatFrame(0,{time:0})),sealed=0;
  for(let i=1;i<=3605;i++){
    a=heatStep(a.checkpoint,heatFrame(i,{time:i*1000}));sealed+=a.facts.reduce((n,g)=>n+g.observed_ms,0);
  }
  assert.equal(sealed+Object.values(a.state.grids).reduce((n,g)=>n+g.observed_ms,0),3605000);
  assert.equal(Object.values(a.checkpoint.dwell.visits)[0]._blocked,true);
  a=heatStep(a.checkpoint,heatFrame(3606,{time:3606000,observation:'predicted'}));
  a=heatStep(a.checkpoint,heatFrame(3607,{time:3607000}));
  assert.equal(sealed+Object.values(a.state.grids).reduce((n,g)=>n+g.observed_ms,0),3605000);
});
test('class version changes close visits and queries never merge equal IDs across vocabularies',async()=>{
  let a=dwellStep(null,heatFrame(0),[heatRule]);a=dwellStep(a.state,heatFrame(1),[heatRule]);
  const changed=heatFrame(2);changed.model.label_map_version='new';
  a=dwellStep(a.state,changed,[{...heatRule,label_map_version:'new'}]);
  assert.equal(a.facts[0].label_map_version,'l');assert.equal(a.facts[0].observed_ms,100);
  assert.equal(Object.values(a.state.visits)[0].label_map_version,'new');
  const rows=[a.facts[0],{...a.facts[0],_id:'new',label_map_version:'new',started_at:'2026-01-01T00:00:01Z',ended_at:'2026-01-01T00:00:01.100Z',observed_intervals:[[Date.UTC(2026,0,1)+1000,Date.UTC(2026,0,1)+1100]]}];
  const query=new DwellQuery({collection:name=>name==='region_dwell_visits'?{find:()=>({sort(){return this},limit(){return this},toArray:async()=>[...rows]}),findOne:async()=>null}:{findOne:async()=>null}});
  const request={channel_id:'c',zone_id:'z',label_ids:['person'],from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'};
  const current=await query.query(request);assert.equal(current.observed_ms,100);assert.equal(current.selected_label_map_version,'new');assert.equal(current.label_map_versions.length,2);
  const old=await query.query({...request,label_map_version:'l'});assert.equal(old.observed_ms,100);assert.equal(old.samples[0].label_map_version,'l');
  const clipped=await query.query({...request,label_map_version:'l',to:'2026-01-01T00:00:00.050Z',thresholds:[50,100]});
  assert.equal(clipped.observed_ms,50);assert.equal(clipped.samples[0].observed_ms,50);assert.equal(clipped.thresholds_ms[50],1);assert.equal(clipped.thresholds_ms[100],0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {seriesFilter,seriesQuery,mergeCoverage} from '../src/flow-statistics.mjs';
import {traversalStep} from '../src/traversal.mjs';
import {coverageStep} from '../src/flow-coverage.mjs';
import {evaluate} from '../src/engine.mjs';
import {behaviorEvent,BehaviorEvents} from '../src/behavior-events.mjs';
const series={key:'in',rule_id:'flow-b',label_ids:['person'],from:'2026-10-21T00:00:00Z',to:'2026-10-21T01:00:00Z',filter:{kind:'edges',entry:['left'],exit:['right']}};
test('a counting series selects one binding by edge identity, never by index or zone version',()=>{
 const q=seriesQuery(series);
 assert.equal(q.rule_id,'flow-b');assert.deepEqual(q.label_id,{$in:['person']});
 assert.equal(q.zone_version,undefined);assert.equal(q.rule_version,undefined);
 assert.deepEqual(q.$and,[{'direction.entry_edge_id':{$in:['left']}},{'direction.exit_edge_id':{$in:['right']}}]);
});
test('line sides and half-open wrapped angles are explicit; a full circle is rejected',()=>{
 assert.deepEqual(seriesQuery({...series,filter:{kind:'line',side:'inward'}}).$and,[{'direction.line_direction':'inward'}]);
 assert.deepEqual(seriesQuery({...series,filter:{kind:'angle',entry:{from:315,to:45},exit:{from:90,to:180}}}).$and,[
  {$or:[{'direction.entry_side_deg':{$gte:315,$lt:360}},{'direction.entry_side_deg':{$gte:0,$lt:45}}]},
  {'direction.exit_side_deg':{$gte:90,$lt:180}}]);
 assert.throws(()=>seriesFilter({kind:'angle',entry:{from:0,to:360},exit:{from:0,to:90}}),/circle/);
 assert.throws(()=>seriesFilter({kind:'edges',entry:[],exit:['a']}));
 assert.throws(()=>seriesFilter({kind:'line',side:'up'}));
});
test('coverage distinguishes no data, partial and complete intervals',()=>{
 const a='2026-10-21T00:00:00Z',b='2026-10-21T00:00:10Z',m='2026-10-21T00:00:05Z';
 assert.equal(mergeCoverage([],a,b).state,'no_data');
 assert.equal(mergeCoverage([{from:a,to:m}],a,'2026-10-21T00:01:00Z').state,'partial');
 assert.equal(mergeCoverage([{from:a,to:m},{from:m,to:b}],a,b).state,'complete');
 // Without an explicit grace a short gap at either end is real missing data.
 assert.equal(mergeCoverage([{from:a,to:m}],a,b).state,'partial');
 assert.equal(mergeCoverage([{from:m,to:b}],a,b).state,'partial');
 // Only the caller knows a period is live (tail write lag) or starts at selection (rule start-up).
 const h='2026-10-21T01:00:00Z',inner=[{from:'2026-10-21T00:00:20Z',to:'2026-10-21T00:59:52Z'}];
 assert.equal(mergeCoverage(inner,a,h).state,'partial');
 assert.equal(mergeCoverage(inner,a,h,{start_ms:30000,end_ms:30000}).state,'complete');
 assert.equal(mergeCoverage(inner,a,h,{end_ms:30000}).state,'partial');
 assert.equal(mergeCoverage([{from:'2026-10-21T00:01:00Z',to:h}],a,h,{start_ms:30000}).state,'partial');
 assert.equal(mergeCoverage([{from:a,to:'2026-10-21T00:20:00Z'},{from:'2026-10-21T00:20:10Z',to:h}],a,h,{start_ms:30000,end_ms:30000}).state,'partial');
 assert.deepEqual(seriesQuery({...series,grace:{end_ms:30000}}).rule_id,'flow-b');
 assert.throws(()=>seriesQuery({...series,grace:{end_ms:3600000}}));
});
test('coverage is written at most every five seconds per binding, yet a new segment is always written',()=>{
 const cp={},r={id:'flow-b',assignment_id:'flow-b',counter_id:'c',version:1,behavior:'region_traverse'};
 assert.deepEqual(coverageStep({},{channel_id:'p',input_stream_id:'in',stream_session_id:'s',seq:'1',captured_at:'2026-10-21T00:00:00Z'},[{...r,counter_id:undefined}],false),[]);
 const f=(seq,second)=>({channel_id:'p',input_stream_id:'in',stream_session_id:'s',seq:String(seq),captured_at:new Date(Date.UTC(2026,9,21,0,0,second)).toISOString()});
 assert.equal(coverageStep(cp,f(1,0),[r],false).length,1);
 assert.equal(coverageStep(cp,f(2,1),[r],false)[0].to,'2026-10-21T00:00:01.000Z');
 assert.equal(coverageStep(cp,f(3,2),[r],false).length,0);
 assert.equal(coverageStep(cp,f(4,6),[r],false).length,1);
 const gap=coverageStep(cp,f(5,7),[r],true);
 assert.equal(gap.length,1);assert.equal(gap[0].from,gap[0].to);
 const written=[...gap,...coverageStep(cp,f(6,8),[r],false)];
 assert.equal(coverageStep(cp,f(7,9),[r],false).length,0);
 const changed=coverageStep(cp,f(8,10),[{...r,version:2}],false);written.push(...changed);
 assert.equal(changed.find(s=>s.rule_version===2).from,'2026-10-21T00:00:10.000Z');
 // The old version's unwritten tail is flushed, and the two spans join across one frame interval.
 assert.equal(changed.find(s=>s.rule_version===1)?.to,'2026-10-21T00:00:09.000Z');
 assert.equal(mergeCoverage(written,'2026-10-21T00:00:07Z','2026-10-21T00:00:09Z').state,'complete');
 assert.equal(mergeCoverage([{from:'2026-10-21T00:00:07Z',to:'2026-10-21T00:00:09Z'},{from:'2026-10-21T00:00:10Z',to:'2026-10-21T00:00:12Z'}],'2026-10-21T00:00:07Z','2026-10-21T00:00:12Z').state,'complete');
});
test('crossing exactly at a polygon vertex is ambiguous and cannot invent an entry edge',()=>{
 const r={points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],hysteresis:.01,duration_ms:0},state={};
 const f=n=>({seq:String(n),source_pts_ns:String(n*1000000000),captured_at:new Date(1760918400000+n*1000).toISOString(),frame_id:String(n),source:{width:1920,height:1080}});
 traversalStep(r,f(1),[.2,.2],state);traversalStep(r,f(2),[.4,.4],state);
 assert.equal(state.traversal_issue,'ambiguous_boundary_crossing');
 assert.equal(traversalStep(r,f(3),[.8,.5],state),null);
});
const counter={id:'flow-b',assignment_id:'flow-b',trigger_version:1,counter_id:'c1',version:1,name:'客流',channel_id:'p',input_stream_id:'in',state:'enabled',label_ids:['person'],
 geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',zone_id:'z',zone_version:1,points:[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],
 edge_ids:['top','right','bottom','left'],alarm_enabled:false,passage:{kind:'zone',max_gap_ms:1000}};
const frame=(seq,x)=>({schema_version:'1.0',channel_id:'p',input_stream_id:'in',stream_session_id:'s',seq:String(seq),frame_id:String(seq),source_pts_ns:String(seq*1000000000),captured_at:new Date(Date.UTC(2026,9,21,0,0,seq)).toISOString(),source:{width:1000,height:1000,coordinate_space:'source_pixels',geometry_revision:'g'},model:{label_map_version:'l'},tracks:[{track_id:'t',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:String(seq*1000000000),bbox:{x:x*1000-10,y:480,w:20,h:20}}]});
function walk(rules,xs){let cp=null;const events=[];xs.forEach((x,i)=>{const r=evaluate(cp,frame(i+1,x),rules);cp=r.checkpoint;events.push(...r.events);});return events;}
test('a counted passage records the stable edge ids of the binding and stays out of alarm activities',()=>{
 const [left,right]=walk([counter],[.2,.4,.6,.8,.6,.4,.2]);
 assert.equal(left.direction.entry_edge_id,'left');assert.equal(left.direction.exit_edge_id,'right');
 assert.equal(right.direction.entry_edge_id,'right');assert.equal(right.direction.exit_edge_id,'left');
 assert.equal(left.episode_id,undefined);
 const fact=behaviorEvent(left);assert.equal(fact.counter_id,'c1');assert.equal(fact.direction.entry_edge_id,'left');
});
test('moving a vertex keeps the edge ids, so later passages land in the same series',()=>{
 const moved={...counter,version:2,points:[[.3,.25],[.72,.3],[.7,.7],[.3,.7]]};
 const [pass]=walk([moved],[.2,.4,.6,.8]);
 assert.equal(pass.direction.entry_edge_id,'left');assert.equal(pass.direction.exit_edge_id,'right');
});
test('renaming a counter keeps its execution version, so a passage in progress still counts',()=>{
 let cp=null;const events=[];
 [.2,.4,.6].forEach((x,i)=>{const r=evaluate(cp,frame(i+1,x),[counter]);cp=r.checkpoint;events.push(...r.events);});
 [.8].forEach((x,i)=>{const r=evaluate(cp,frame(i+4,x),[{...counter,name:'正门客流',trigger_version:2}]);cp=r.checkpoint;events.push(...r.events);});
 assert.equal(events.length,1);assert.equal(events[0].direction.exit_edge_id,'right');
});
test('a counter rule beside an alarm rule on one channel does not stop the alarm',()=>{
 const alarm={id:'alarm',version:1,name:'穿过告警',channel_id:'p',state:'enabled',label_ids:['person'],geometry_revision:'g',label_map_version:'l',behavior:'region_traverse',zone_id:'z',zone_version:1,assignment_id:'alarm',trigger_version:1,points:counter.points};
 const events=walk([counter,alarm],[.2,.4,.6,.8]);
 assert.deepEqual(events.map(e=>[e.rule.id,!!e.episode_id]).sort(),[['alarm',true],['flow-b',false]]);
});
test('behavior statistics and history never include counter facts',async()=>{
 const seen=[];const collection={find:q=>{seen.push(q);return {sort:()=>({limit:()=>({toArray:async()=>[]})})};},aggregate:q=>{seen.push(q[0].$match);return {toArray:async()=>[]};}};
 const facts=new BehaviorEvents({collection:()=>collection});
 const range={from:'2026-10-21T00:00:00Z',to:'2026-10-21T01:00:00Z'};
 await facts.list(range);await facts.statistics(range);
 for(const q of seen)assert.deepEqual(q.counter_id,{$exists:false});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {RegionHeatQuery} from '../src/region-heat-query.mjs';
import {materializeRegionHeat,HEAT_MAX_GRIDS} from '../src/region-heat.mjs';
import {heatFrame,heatRule,heatStep} from './region-heat-fixtures.mjs';
function queryRows(data,heat={grids:{}},options={},probe={}){return new RegionHeatQuery({collection:name=>name==='region_heat_minutes'?{
  find:(filter,options)=>{probe.options=options;return {async *[Symbol.asyncIterator](){for(const row of data)yield row;},async close(){probe.closed=true;}};},findOne:async()=>data[0]??null,
}:{findOne:async(filter,options)=>{probe.checkpointOptions=options;return {checkpoint:{region_heat:heat},open_heat_minute:Object.values(heat.grids??{}).map(g=>g.from).sort()[0]??null,last_consumed_at:'2026-01-01T00:01:00Z'};}}},options);}
test('same accepted dwell pairs conserve target-time across minute close without counting coasts or duplicate counters',()=>{
  const rules=[heatRule,{...heatRule,id:'counter2'}];let a=heatStep(null,heatFrame(1,{time:59800}),rules);a=heatStep(a.checkpoint,heatFrame(2,{time:60200}),rules);
  assert.equal(a.facts.length,1);assert.equal(a.facts[0].observed_ms,200);assert.equal(Object.values(a.state.grids)[0].observed_ms,200);
  assert.equal(a.facts[0].values_ms.reduce((a,b)=>a+b,0),200);assert.equal(a.facts[0].values_ms.length,144);
  a=heatStep(a.checkpoint,heatFrame(3,{time:60300,observation:'lost'}),rules);a=heatStep(a.checkpoint,heatFrame(4,{time:60400}),rules);
  assert.equal(Object.values(a.state.grids)[0].observed_ms,200);
  a=heatStep(a.checkpoint,heatFrame(5,{time:60500}),rules);assert.equal(Object.values(a.state.grids)[0].observed_ms,300);
});
test('heat uses previous observed source anchor and wraps ERP x to the source grid',()=>{
  let a=heatStep(null,heatFrame(1,{x:.25}));a=heatStep(a.checkpoint,heatFrame(2,{x:.55}));
  const grid=Object.values(a.state.grids)[0];assert.equal(grid.values_ms[3*16+4],100);assert.equal(grid.values_ms[3*16+9],0);
  const erp={...heatRule,erp_wrap:true,points:[[.9,.2],[.1,.2],[.1,.8],[.9,.8]]};
  a=heatStep(null,heatFrame(1,{x:.9}),[erp]);a=heatStep(a.checkpoint,heatFrame(2,{x:0}),[erp]);a=heatStep(a.checkpoint,heatFrame(3,{x:.01}),[erp]);
  const wrap=Object.values(a.state.grids)[0];assert.equal(wrap.values_ms[3*16+15],100);assert.equal(wrap.values_ms[3*16],100);
});
test('source/session/zone changes seal old grids and never bridge coordinate frames',()=>{
  for(const change of ['session','geometry','dimensions','zone','view','input']){
    let a=heatStep(null,heatFrame(1));a=heatStep(a.checkpoint,heatFrame(2));
    const opts=change==='session'?{session:'s2'}:change==='geometry'?{geometry:'g2'}:change==='dimensions'?{width:200}:{};
    const rule=change==='geometry'?{...heatRule,geometry_revision:'g2'}:change==='zone'?{...heatRule,zone_version:2}:change==='view'?{...heatRule,view_epoch:'a'.repeat(64)}:heatRule;
    const frame=seq=>({...heatFrame(seq,opts),...(change==='input'?{input_stream_id:'in2'}:{})});
    a=heatStep(a.checkpoint,frame(3),[rule]);assert.equal(a.facts.length,1,change);assert.equal(a.facts[0].observed_ms,100);assert.equal(Object.keys(a.state.grids).length,0);
    a=heatStep(a.checkpoint,frame(4),[rule]);assert.equal(Object.values(a.state.grids)[0].observed_ms,100);
  }
});
test('query discards partial minutes, reports open-minute lag, and keeps incompatible variants separate',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));
  const row=a.facts[0],query=queryRows([row,{...row,_id:'other',stream_session_id:'other',geometry_revision:'g2'},{...row,_id:'third',input_stream_id:'in2'}],a.state);
  const out=await query.query({channel_id:'c',zone_id:'z',from:'2025-12-31T23:59:59.500Z',to:'2026-01-01T00:01:59.500Z'});
  assert.equal(out.effective_from,'2026-01-01T00:00:00.000Z');assert.equal(out.effective_to,'2026-01-01T00:01:00.000Z');assert.equal(out.variants.length,3);assert.equal(out.discarded_edges.length,2);assert.ok(out.issues.includes('open_minute_lag'));assert.equal(out.coverage,'unknown');
  const short=await query.query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:01Z',to:'2026-01-01T00:00:20Z'});
  assert.equal(short.status,'no_complete_minutes');assert.equal(short.effective_from,null);assert.deepEqual(short.variants,[]);
});
test('compatible sessions combine target-time, but source/geometry/label-map and unknown history stay separate',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const row=a.facts[0];
  const unknown={...row};delete unknown.label_map_version;
  const out=await queryRows([row,{...row,stream_session_id:'second'},{...row,input_stream_id:'camera2'},{...row,geometry_revision:'other'},
    {...row,label_map_version:'l2'},unknown,{...unknown,stream_session_id:'legacy2'}]).query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
  assert.equal(out.session_scope,'compatible_source_geometry');assert.equal(out.variants.length,5);
  assert.equal(out.variants.find(v=>v.input_stream_id==='in'&&v.geometry_revision==='g'&&v.label_map_version==='l').observed_ms,400);
  assert.equal(out.variants.find(v=>v.label_map_version===null).observed_ms,400);assert.ok(out.issues.includes('heat_label_map_unknown'));
  assert.equal(out.variants.reduce((n,v)=>n+v.observed_ms,0),1400);assert.ok(out.variants.every(v=>!Object.hasOwn(v,'stream_session_id')));
});
test('model changes within a session stamp new rows and never assign coast time to either label map',()=>{
  let a=heatStep(null,heatFrame(1));a=heatStep(a.checkpoint,heatFrame(2));a=heatStep(a.checkpoint,heatFrame(3,{observation:'lost'}));
  const rule={...heatRule,label_map_version:'l2'},frame=(seq,opts)=>{const f=heatFrame(seq,opts);f.model.label_map_version='l2';return f;};
  a=heatStep(a.checkpoint,frame(4),[rule]);const old=a.facts[0];assert.equal(old.label_map_version,'l');assert.equal(old.observed_ms,100);assert.equal(Object.keys(a.state.grids).length,0);
  a=heatStep(a.checkpoint,frame(5),[rule]);a=heatStep(a.checkpoint,frame(6,{time:60000,empty:true}),[rule]);
  const next=a.facts[0];assert.equal(next.label_map_version,'l2');assert.equal(next.observed_ms,100);assert.equal(next.stream_session_id,old.stream_session_id);assert.notEqual(next._id,old._id);
});
test('legacy open grids are sealed unknown rather than retroactively stamped with the current model',async()=>{
  let a=heatStep(null,heatFrame(1));a=heatStep(a.checkpoint,heatFrame(2));delete Object.values(a.state.grids)[0].label_map_version;
  a=heatStep(a.checkpoint,heatFrame(3));const legacy=a.facts[0];assert.equal(legacy.label_map_version,undefined);assert.equal(legacy.observed_ms,100);assert.equal(Object.keys(a.state.grids).length,0);
  a=heatStep(a.checkpoint,heatFrame(4));a=heatStep(a.checkpoint,heatFrame(5,{time:60000,empty:true}));const current=a.facts[0];
  assert.equal(current.label_map_version,'l');assert.equal(current.observed_ms,100);assert.notEqual(current._id,legacy._id);
  const out=await queryRows([legacy,current]).query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:01:00Z'});
  assert.equal(out.variants.length,2);assert.ok(out.issues.includes('heat_label_map_unknown'));
});
test('prepared minute replay is idempotent',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));
  const rows=new Map(),db={collection:()=>({bulkWrite:async ops=>{for(const {updateOne:o} of ops)if(!rows.has(o.filter._id))rows.set(o.filter._id,o.update.$setOnInsert);}})};
  await assert.rejects(materializeRegionHeat(db,a.facts,async()=>{throw Error('injected')}),/injected/);await materializeRegionHeat(db,a.facts);assert.equal(rows.size,1);
});
test('finite resource sanity: repeated pair integration stays bounded and grid overflow suspends heat',()=>{
  const started=performance.now();let a=heatStep(null,heatFrame(1,{time:0}));
  for(let i=2;i<=500;i++)a=heatStep(a.checkpoint,heatFrame(i,{time:i*20}));
  assert.equal(Object.keys(a.state.grids).length,1);assert.ok(Buffer.byteLength(JSON.stringify(a.state))<8192);assert.ok(performance.now()-started<10000);
  // More distinct region/label grids than the independent heat budget, while
  // dwell remains within its own 512-visit budget.
  const labels=Array.from({length:129},(_,i)=>`p${i}`),rule={...heatRule,label_ids:labels.slice(0,128)},rule2={...heatRule,id:'second',label_ids:[labels[128]]};
  const frame=seq=>{const f=heatFrame(seq);f.tracks=labels.map((label,i)=>({...f.tracks[0],track_id:`t${i}`,label_id:label}));return f;};
  a=heatStep(null,frame(1),[rule,rule2]);a=heatStep(a.checkpoint,frame(2),[rule,rule2]);
  assert.equal(a.state.disabled_session,'s');assert.ok(a.issues.includes('heat_grid_capacity'));assert.equal(Object.keys(a.checkpoint.dwell.visits).length,129);assert.equal(HEAT_MAX_GRIDS,128);
});
test('streaming aggregation accepts all 50000 retained rows, yields to the event loop and closes its cursor',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const row=a.facts[0],probe={};
  function* rows(){for(let i=0;i<50000;i++)yield {...row,stream_session_id:`session${i}`};}
  const started=performance.now();let yielded=false;setImmediate(()=>{yielded=true;});
  const out=await queryRows(rows(),undefined,{},probe).query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-31T00:00:00Z'});
  assert.equal(out.variants[0].observed_ms,50000*200);assert.equal(out.variants[0].values_ms.reduce((a,b)=>a+b,0),50000*200);assert.equal(probe.closed,true);assert.equal(yielded,true);
  assert.equal(probe.options.batchSize,128);assert.equal(probe.options.limit,50001);assert.equal(probe.options.timeoutMode,'cursorLifetime');assert.ok(probe.options.maxTimeMS>0&&probe.options.maxTimeMS<=15000);assert.ok(probe.options.timeoutMS<=15000);assert.equal(probe.options.sort,undefined);assert.ok(performance.now()-started<15000);
  assert.equal(probe.checkpointOptions.projection['checkpoint.region_heat'],undefined);assert.ok(probe.checkpointOptions.projection.open_heat_minute);
  assert.equal(probe.options.projection.stream_session_id,undefined);assert.equal(probe.options.projection.label_map_version,1);assert.equal(out.variants.length,1);assert.equal(out.session_scope,'compatible_source_geometry');
});
test('streaming overflow and variant limits fail explicitly and close the cursor',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const row=a.facts[0];
  const request={channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'};
  function* excess(){for(let i=0;i<50001;i++)yield row;}
  const bound={};await assert.rejects(queryRows(excess(),undefined,{},bound).query(request),e=>e.code==='heat_query_capacity');assert.equal(bound.closed,true);
  function* variants(){for(let i=0;i<65;i++)yield {...row,input_stream_id:`input${i}`};}
  const limit={};await assert.rejects(queryRows(variants(),undefined,{},limit).query(request),e=>e.code==='heat_query_capacity');assert.equal(limit.closed,true);
});
test('the total query deadline interrupts CPU iteration and closes its cursor without returning partial totals',async()=>{
  let a=heatStep(null,heatFrame(1,{time:59800}));a=heatStep(a.checkpoint,heatFrame(2,{time:60200}));const row=a.facts[0],probe={};let now=0;
  function* slow(){yield row;now=15001;yield row;}
  await assert.rejects(queryRows(slow(),undefined,{now:()=>now},probe).query({channel_id:'c',zone_id:'z',from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z'}),e=>e.code==='heat_query_timeout'&&e.status===503);assert.equal(probe.closed,true);
});

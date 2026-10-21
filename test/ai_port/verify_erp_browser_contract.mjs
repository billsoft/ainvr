// Validate the actual isolated browser-saved contract through the production engine.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {evaluate} from '../../alarm-service/src/engine.mjs';
const base=new URL('../results/',import.meta.url);
const saved=JSON.parse(await readFile(new URL('erp-browser-associated.json',base),'utf8'));
const whole=JSON.parse(await readFile(new URL('erp-browser-wholeframe.json',base),'utf8'));
const rule=saved.snapshot.rules[0],zone=saved.arming.zones[0];
assert.equal(rule.erp_wrap,true);assert.deepEqual(rule.points,zone.points);
assert.deepEqual(rule.entry_edges,[3]);assert.deepEqual(rule.exit_edges,[1]);
assert.equal(rule.id,saved.arming.assignments[0].assignment_id);
assert.equal(whole.arming.zones.length,0);assert.equal(whole.snapshot.rules.length,1);
assert.equal(whole.snapshot.rules[0].behavior,'appearance');assert.equal(whole.snapshot.rules[0].zone_id,null);
let checkpoint=null,seq=0,events=[];
const {width,height}=rule.source_binding;
for(const x of [.90,.96,.02,.10]){
 const pts=String(BigInt(++seq)*100000000n);
 const frame={schema_version:'1.0',channel_id:rule.channel_id,input_stream_id:rule.input_stream_id,stream_session_id:'browser-replay',seq:String(seq),frame_id:String(seq),source_pts_ns:pts,captured_at:new Date(Date.parse('2026-10-20T14:00:00Z')+seq*100).toISOString(),source:{width,height,coordinate_space:'source_pixels',geometry_revision:rule.geometry_revision},model:{label_map_version:rule.label_map_version},tracks:[{track_id:'browser-person',label_id:'person',state:'confirmed',observation:'detected',last_observed_pts_ns:pts,bbox:{x:x*width-5,y:.60*height-20,w:10,h:20}}]};
 const out=evaluate(checkpoint,frame,[rule]);checkpoint=out.checkpoint;events.push(...out.events);
}
assert.equal(events.length,1);assert.equal(events[0].direction.entry_edge,3);assert.equal(events[0].direction.exit_edge,1);
await writeFile(new URL('erp-browser-contract-verification.json',base),JSON.stringify({phase:'passed',saved_zone_id:zone.zone_id,assignment_id:rule.id,entry_edge:3,exit_edge:1,real_browser_saved_contract:true,seam_passage_events:events.length,whole_frame_without_zone:true,production_configuration_changed:false},null,2)+'\n');


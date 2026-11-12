import test from 'node:test';
import assert from 'node:assert/strict';
import {fusePlates,VehicleRecognition} from '../src/vehicle-recognition.mjs';
const frame=(key,text='京A12345')=>({frame_key:key,result:{candidates:[{status:'candidate',text,color_index:1}]}});
test('different real frames agree; scores are not probabilities',()=>{assert.equal(fusePlates([frame('a'),frame('b')]).state,'consistent');assert.equal(fusePlates([frame('a'),frame('a')]).state,'single_frame');});
test('conflicting complete strings never splice or select a majority',()=>{assert.equal(fusePlates([frame('a'),frame('b'),frame('c','沪B12345')]).state,'ambiguous');});
test('multiple plates within vehicle ROI do not nominate a winner',()=>{const f=frame('a');f.result.candidates.push(frame('b').result.candidates[0]);assert.equal(fusePlates([f]).state,'unreadable');});
test('no detection is not a no-plate assertion',()=>{assert.equal(fusePlates([{frame_key:'a',result:{candidates:[]}}]).state,'plate_not_detected');});
function service(){return new VehicleRecognition({db:{collection:()=>({})}},{clock:()=>100000,invoke:async()=>({})});}
const config=()=>({issued_ms:100000,expires_ms:145000,channels:['channel'],counter_ids:['counter'],model_pin:'a'.repeat(64),watchlist:{version:1,entries:[]}});
test('configuration attaches only to selected vehicle counters and preserves input',()=>{const s=service();s.configure(config());const rules=[{counter_id:'counter',alarm_enabled:false},{counter_id:'person'}];const out=s.rules(rules,'channel');assert.ok(out[0].vehicle_capture);assert.equal(out[0].alarm_enabled,false);assert.equal(out[1],rules[1]);assert.equal(rules[0].vehicle_capture,undefined);assert.equal(s.rules(rules,'other')[0],rules[0]);});
test('stale and oversized grants fail closed',()=>{const s=service();assert.throws(()=>s.configure({...config(),expires_ms:170000}));s.configure(config());assert.throws(()=>s.configure({...config(),issued_ms:99999}));});
test('same-event correction and automatic publication serialize even after failure',async()=>{const s=service(),seen=[];const a=s.exclusive('x',async()=>{seen.push(1);await new Promise(r=>setTimeout(r,5));seen.push(2);throw Error('test');});const b=s.exclusive('x',async()=>{seen.push(3);});await assert.rejects(a);await b;assert.deepEqual(seen,[1,2,3]);assert.equal(s.locks.size,0);});
test('manual correction suppresses pending automatic watchlist alarm',async()=>{const s=service();s.repository.behaviors={get:async()=>({vehicle:{corrected:true,text:'京A12345'}})};s.repository.insert=()=>{throw Error('must not publish')};await s.alarm({_id:'x'}, {text:'京A12345'});});

test('new rule snapshots retain only bounded watchlist identity',()=>{const s=service();s.configure({...config(),watchlist:{version:1,entries:Array.from({length:500},(_,i)=>({plate:'京A'+String(i).padStart(5,'0')}))}});const rule=s.rules([{counter_id:'counter'}],'channel')[0];assert.equal(rule.vehicle_capture.watchlist.entries,undefined);assert.equal(rule.vehicle_capture.watchlist.digest.length,64);assert.ok(JSON.stringify(rule.vehicle_capture).length<250);});
test('special suffix plates can be fused but unsupported formats remain unreadable',()=>{assert.equal(fusePlates([frame('a','粤Z1234港'),frame('b','粤Z1234港')]).state,'consistent');assert.equal(fusePlates([frame('a','人A12345'),frame('b','人A12345')]).state,'unreadable');});

test('all advertised special suffixes and ordinary/new energy plates share the fusion contract',()=>{for(const text of ['京A12345','沪B123456',...['挂','学','警','港','澳'].map(s=>'粤A1234'+s)]){assert.equal(fusePlates([{frame_key:'a',result:{candidates:[{status:'candidate',text}]}},{frame_key:'b',result:{candidates:[{status:'candidate',text}]}}]).state,'consistent',text);}});

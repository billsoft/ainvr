import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigCenterController,validateBootstrap} from '../src/config-center.mjs';
const settings={host:'127.0.0.1',port:8200,mongo_uri:'mongodb://127.0.0.1:27028',database:'ainvr_alarm_test',api_token:'api-test-'.repeat(8),producer_token:'producer-test-'.repeat(8)};
function fixture(){
  let version=1,config=settings;const reports=[],starts=[],closed=[];
  const request=async(path,body)=>{
    if(body){reports.push(body);return body;}
    if(path==='service-states/alarm-service')return {desiredVersion:version};
    assert.match(path,/snapshot\?service=alarm-service$/);
    return [{service:'alarm-service',group:'system',name:'settings',config}];
  };
  const start=async candidate=>{starts.push(candidate.version);if(candidate.port===9999)throw Error('private connection details');return {close:async()=>{closed.push(candidate.version)}};};
  return {controller:new ConfigCenterController({request,start}),reports,starts,closed,set:(v,c=settings)=>{version=v;config=c}};
}
test('configuration starts before reporting applied; unchanged version does not restart',async()=>{
  const f=fixture();await f.controller.tick();await f.controller.tick();
  assert.deepEqual(f.starts,[1]);assert.equal(f.reports.at(-1).appliedVersion,1);assert.equal(f.reports.at(-1).status,'applied');
  await f.controller.close();assert.deepEqual(f.closed,[1]);
});
test('invalid configuration preserves listener; failed startup restores the previous version without claiming success',async()=>{
  const f=fixture();await f.controller.tick();f.set(2,{...settings,host:'0.0.0.0'});await f.controller.tick();
  assert.deepEqual(f.closed,[]);assert.equal(f.reports.at(-1).status,'failed');
  f.set(3,{...settings,port:9999});await f.controller.tick();
  assert.deepEqual(f.starts,[1,3,1]);assert.deepEqual(f.closed,[1]);
  assert.equal(f.reports.at(-1).appliedVersion,1);assert.equal(f.reports.at(-1).status,'failed');assert.ok(!JSON.stringify(f.reports).includes('private connection'));
  f.set(4);await f.controller.tick();assert.equal(f.reports.at(-1).appliedVersion,4);await f.controller.close();
});
test('bootstrap rejects remote destinations, malformed credentials and polling storms',()=>{
  const b={control_url:'http://127.0.0.1:8088',service_token:'config-test-'.repeat(4),poll_ms:5000};
  assert.equal(validateBootstrap(b).poll_ms,5000);
  for(const p of [{control_url:'http://external.invalid:8088'},{poll_ms:10},{service_token:'short'},{extra:true}])assert.throws(()=>validateBootstrap({...b,...p}));
});

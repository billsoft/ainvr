import test from 'node:test';
import assert from 'node:assert/strict';
import {freshModelTransition,freshModelSettings,validateFreshModelManifest,validateCollections,NEW_PACKAGE,OLD_PACKAGE,acquireDeploymentLock,recoverFreshModelServices,waitForCondition,freshModelReady} from '../../deploy-package/search_fresh_model_policy.mjs';
const forward=freshModelTransition(OLD_PACKAGE,NEW_PACKAGE),reverse=freshModelTransition(NEW_PACKAGE,OLD_PACKAGE);
const model='search-v1-'+'a'.repeat(64),pin={package_id:'siglip2-base-full-int8',model_version:model};
const settings={model:{package_id:pin.package_id},sampling:{object_interval_ms:1000,scene_active_interval_ms:10000,scene_static_interval_ms:60000,scene_change_min_interval_ms:3000,channel_ids:['preserved']},limits:{producer_queue:4,max_bytes:123},callers:['preserved']};
test('fresh cutover changes paired model and bounded search rates only',()=>{
 const before=structuredClone(settings),next=freshModelSettings(settings,pin,[model],forward);
 assert.deepEqual(settings,before);assert.equal(next.model.package_id,NEW_PACKAGE);
 assert.equal(next.sampling.object_interval_ms,4000);assert.equal(next.sampling.scene_active_interval_ms,20000);
 assert.equal(next.sampling.scene_change_min_interval_ms,5000);assert.equal(next.limits.producer_queue,1);
 assert.deepEqual(next.callers,settings.callers);assert.deepEqual(next.sampling.channel_ids,['preserved']);assert.equal(next.limits.max_bytes,123);
});
test('slower user timing is retained',()=>{const s=structuredClone(settings);s.sampling.object_interval_ms=10000;assert.equal(freshModelSettings(s,pin,[],forward).sampling.object_interval_ms,10000)});
test('reject mixed or changed vector spaces before deletion',()=>{assert.throws(()=>freshModelSettings(settings,pin,['other'],forward));assert.throws(()=>freshModelSettings(settings,null,[],forward));assert.throws(()=>freshModelSettings({...settings,model:{package_id:NEW_PACKAGE}},pin,[],forward))});

test('transitions require the explicit supported source and target pair',()=>{
 assert.equal(forward.sourceDimensions,768);assert.equal(forward.targetDimensions,1152);
 assert.equal(reverse.sourceDimensions,1152);assert.equal(reverse.targetDimensions,768);
 for(const pair of [[OLD_PACKAGE,OLD_PACKAGE],[NEW_PACKAGE,NEW_PACKAGE],['unknown',OLD_PACKAGE],[OLD_PACKAGE,'unknown'],[undefined,undefined]])
  assert.throws(()=>freshModelTransition(...pair),/unsupported_fresh_model_transition/);
 assert.throws(()=>freshModelSettings(settings,pin,[]),/unsupported_fresh_model_transition/);
});

test('reverse changes only the package and preserves every current sampling and limit field',()=>{
 const current={...structuredClone(settings),model:{package_id:NEW_PACKAGE,other:'preserved'}};
 current.sampling.extra={enabled:true};current.limits.producer_queue=7;
 const before=structuredClone(current),sourcePin={...pin,package_id:NEW_PACKAGE};
 const next=freshModelSettings(current,sourcePin,[model],reverse);
 assert.deepEqual(current,before);
 assert.deepEqual(next,{...before,model:{...before.model,package_id:OLD_PACKAGE}});
 assert.throws(()=>freshModelSettings(current,sourcePin,['other'],reverse),/fresh_switch_source_mismatch/);
 assert.throws(()=>freshModelSettings(current,pin,[],reverse),/fresh_switch_source_mismatch/);
 assert.throws(()=>freshModelSettings(settings,sourcePin,[],reverse),/fresh_switch_source_mismatch/);
});

test('index manifests match source dimensions and source pin in both directions',()=>{
 for(const transition of [forward,reverse]){
  const sourcePin={...pin,package_id:transition.sourcePackage};
  const manifest={dimensions:transition.sourceDimensions,model_version:model};
  assert.doesNotThrow(()=>validateFreshModelManifest(manifest,sourcePin,transition));
  for(const bad of [{...manifest,dimensions:transition.targetDimensions},{...manifest,model_version:'other'},{...manifest,dimensions:String(transition.sourceDimensions)},null])
   assert.throws(()=>validateFreshModelManifest(bad,sourcePin,transition),/mixed_index_space/);
  assert.throws(()=>validateFreshModelManifest(manifest,{...sourcePin,package_id:transition.targetPackage},transition),/mixed_index_space/);
 }
});
test('only explicit derived search collections are selected',()=>{assert.deepEqual(validateCollections(['alarms','recognitions','search_samples','search_control']),['search_samples','search_control']);assert.throws(()=>validateCollections(['search_future_unknown']))});

test('deployment lock stays held until release and closes on contention',()=>{
 const calls=[];
 const io={open:p=>{calls.push(['open',p]);return 9},lock:fd=>calls.push(['lock',fd]),close:fd=>calls.push(['close',fd])};
 const release=acquireDeploymentLock(io);
 assert.deepEqual(calls,[['open','/run/lock/ainvr-ptz-deploy.lock'],['lock',9]]);
 release();release();assert.deepEqual(calls.at(-1),['close',9]);assert.equal(calls.length,3);
 assert.throws(()=>acquireDeploymentLock({...io,lock:()=>{throw Error('busy')}}),/deployment_lock_unavailable/);
 assert.deepEqual(calls.at(-1),['close',9]);
});
test('recovery attempts every service even when stops fail',()=>{
 for(const failed of [[],['ainvr-ai'],['ainvr-ai','ainvr-search','ainvr-backend']]){
  const calls=[];
  const errors=recoverFreshModelServices((...args)=>{calls.push(args);if(failed.includes(args[2]))throw Error('failed')});
  assert.deepEqual(calls,[['systemctl','stop','ainvr-ai'],['systemctl','stop','ainvr-search'],['systemctl','start','ainvr-backend']]);
  assert.equal(errors.length,failed.length);
 }
});
test('readiness retries failures within a bounded deadline',async()=>{
 let clock=0,calls=0;const sleeps=[];
 const options={timeoutMs:12,intervalMs:5,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms}};
 await assert.rejects(waitForCondition(()=>{++calls;throw Error('not_ready')},options),/fresh_model_readiness_timeout/);
 assert.equal(clock,12);assert.equal(calls,3);assert.deepEqual(sleeps,[5,5,2]);
 clock=0;calls=0;await waitForCondition(()=>++calls===2,options);assert.equal(clock,5);
});
test('fresh readiness requires the new pinned text/vision space and business readiness',()=>{
 const runtime={desired_version:18,active_model_pin:{package_id:NEW_PACKAGE,model_version:model}};
 const status={ready:true,model_version:model};
 const ai={status:'ok',business:{ready:true,search_sampling:{ready:true,model_version:model}}};
 assert.equal(freshModelReady(runtime,status,ai,18,true,forward),true);
 assert.equal(freshModelReady(runtime,{...status,ready:false},ai,18,true,forward),false);
 assert.equal(freshModelReady(runtime,{...status,model_version:'old'},ai,18,true,forward),false);
 assert.equal(freshModelReady({...runtime,active_model_pin:pin},status,ai,18,true,forward),false);
 assert.equal(freshModelReady(runtime,status,ai,17,true,forward),false);
 assert.equal(freshModelReady(runtime,status,{status:'ok',business:{ready:true,search_sampling:{ready:true,model_version:'old'}}},18,false,forward),false);
 const idle={status:'ok',business:{ready:true,search_sampling:{ready:false}}};
 assert.equal(freshModelReady(runtime,status,idle,18,false,forward),true);
 assert.equal(freshModelReady(runtime,status,idle,18,true,forward),false);
 assert.equal(freshModelReady(runtime,status,{status:'ok',business:{ready:false}},18,false,forward),false);
});

test('reverse readiness accepts only the SigLIP2 target pin and its matching text/vision versions',()=>{
 const runtime={desired_version:18,active_model_pin:pin};
 const status={ready:true,model_version:model};
 const ai={status:'ok',business:{ready:true,search_sampling:{ready:true,model_version:model}}};
 assert.equal(freshModelReady(runtime,status,ai,18,true,reverse),true);
 assert.equal(freshModelReady({...runtime,active_model_pin:{...pin,package_id:NEW_PACKAGE}},status,ai,18,true,reverse),false);
 assert.equal(freshModelReady(runtime,{...status,model_version:'other'},ai,18,true,reverse),false);
 assert.equal(freshModelReady(runtime,status,{...ai,business:{...ai.business,search_sampling:{ready:true,model_version:'other'}}},18,false,reverse),false);
});

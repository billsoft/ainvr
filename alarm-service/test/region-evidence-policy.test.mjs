import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReviewContext} from '../src/review-context.mjs';

test('only armed region alarm channels request empty-scene evidence; removal preserves ordinary target evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ainvr-region-policy-'));
 let rules=[
  {channel_id:'empty',state:'enabled',region_state:{operator:'count_below'}},
  {channel_id:'empty',state:'enabled',region_state:{operator:'presence'}},
  {channel_id:'ordinary',state:'enabled'},
  {channel_id:'disabled',state:'disabled',region_state:{operator:'count_below'}},
  {channel_id:'counter',state:'enabled',alarm_enabled:false,region_state:{operator:'count_below'}},
 ];
 const repository={ruleSnapshots:{current:async()=>({rules})},vehicles:{channels:()=>['vehicle']}};
 const context=new ReviewContext(repository,'/mnt/ainvr-ssd/region-policy-test');
 context.root=root;
 try{
  await context.publish();
  const read=async()=>JSON.parse(await readFile(join(root,'enabled.json'),'utf8'));
  assert.deepEqual((await read()).region_channels,['empty']);
  assert.deepEqual(new Set((await read()).channels),new Set(['vehicle','empty','ordinary']));
  rules=[{channel_id:'empty',state:'enabled'}];context.lastPolicy=0;
  await context.publish();assert.deepEqual((await read()).region_channels,[]);
  assert.ok((await read()).channels.includes('empty'));
  repository.ruleSnapshots.current=async()=>{throw Error('database down');};context.lastPolicy=0;
  await assert.rejects(context.publish(),/database down/);
  assert.deepEqual((await read()).region_channels,[],'a failed refresh must not replace the last committed policy');
 }finally{await rm(root,{recursive:true,force:true});}
});

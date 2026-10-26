import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {matchesQualification} from '../src/review-qualification.mjs';
test('offline signing refuses wrong decisions and scopes a valid test artifact to its label and prompt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ainvr-sign-test-'));
 try{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');await writeFile(join(dir,'key'),privateKey.export({format:'pem',type:'pkcs8'}));
  const result={model:{package_sha256:'a'.repeat(64)},template:'alarm-review-zh-v1'};
  const report={schema:'ainvr.review-score.v1',caller_template:'target-context-zh-v3-border',thresholds:{approve_above:.95,reject_below:.05,version:'test'},errors:[],results:Array.from({length:200},(_,i)=>({...result,id:String(i),group:String(i),sha256:String(i),split:'test',label:'人',visual_label:i<100,real_score:i<100?.99:.01}))};
  const save=async()=>{const bytes=JSON.stringify(report);await writeFile(join(dir,'report'),bytes);await writeFile(join(dir,'accept'),JSON.stringify({approved:true,dataset_independent:true,reviewer:'test-only',report_sha256:createHash('sha256').update(bytes).digest('hex'),expires_at:new Date(Date.now()+86400000).toISOString()}));};
  const run=out=>spawnSync(process.execPath,[new URL('../../deploy-package/sign-review-validation.mjs',import.meta.url).pathname,join(dir,'report'),join(dir,'accept'),join(dir,'key'),join(dir,out)],{encoding:'utf8'});
  await save();assert.equal(run('envelope').status,0);
  const envelope=JSON.parse(await readFile(join(dir,'envelope'),'utf8'));
  assert.equal(matchesQualification(envelope,publicKey,{...result,prepared_image:{layout:'target-crop-v1'},caller_template:'target-context-zh-v3-border',target_label:'人'},report.thresholds),true);
  report.results[100].real_score=.99;await save();assert.notEqual(run('wrong').status,0);
  report.results[100].real_score=.01;report.results[0].split='development';await save();assert.notEqual(run('small').status,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

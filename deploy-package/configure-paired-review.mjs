#!/usr/bin/env node
// Explicit operator opt-in for the measured 2B package. No credentials or model files change.
import {readFile,writeFile,stat,mkdir,rename,copyFile,readdir,rm,chown,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {parseAuthorization} from '../alarm-service/src/review-authorization.mjs';
import {FOCUS_LAYOUT,FOCUS_DEFAULTS} from '../alarm-service/src/review-focus.mjs';
import {PAIRED_SUPPORT_DEFAULTS} from '../alarm-service/src/review-secondary.mjs';
const packageHash='e74174589a8a4c2b43f2e7e1865ad7430401689d65c066235cbc1552e3b45281';
if(process.argv.slice(2).some(arg=>!['--apply','--focus'].includes(arg)))throw Error('Usage: configure-paired-review.mjs [--apply] [--focus]');
const path='/etc/ainvr/review-authorization.json',info=await stat(path);
if(info.uid!==0||(info.mode&0o022))throw Error('Private root-owned authorization required');
const before=await readFile(path,'utf8'),current=JSON.parse(before);
if(!parseAuthorization(current)||current.mode!=='confirm_or_reject'||current.labels.some(x=>x!=='person')||current.model_sha256!==packageHash)throw Error('Requires existing person dual-review authorization for measured 2B package');
const health=await fetch('http://127.0.0.1:8300/health',{signal:AbortSignal.timeout(5000)});
if(!health.ok)throw Error('Model health unavailable');
const model=await health.json();
if(!model.ready||model.package_sha256!==packageHash)throw Error('Loaded model does not match measured policy');
const focus=process.argv.includes('--focus');
if(focus&&!model.preparation_profiles?.includes(FOCUS_LAYOUT))throw Error('Running LLM does not support focused target preparation');
// Do not replace an existing explicit paired policy (including stricter thresholds).
if(current.secondary.paired_support&&(!focus||current.focus)){console.log('Paired policy already configured; unchanged');process.exit(0);}
const next={...current,...(focus?{focus:{...FOCUS_DEFAULTS}}:{}),secondary:{...current.secondary,paired_support:current.secondary.paired_support??{...PAIRED_SUPPORT_DEFAULTS}},authorized_at:new Date().toISOString(),authorized_by:current.authorized_by+(focus?'; owner-approved focused target evidence':' ; owner-approved paired evidence')};
if(!parseAuthorization(next))throw Error('Invalid proposed authorization');
console.log(JSON.stringify({model_sha256:packageHash,paired_support:next.secondary.paired_support,focus:next.focus??null,legacy_primary_thresholds_unchanged:true,legacy_rejection_thresholds_unchanged:true,accuracy_validated:false,apply:process.argv.includes('--apply')}));
if(!process.argv.includes('--apply'))process.exit(0);
if(process.getuid?.()!==0)throw Error('Requires root');
execFileSync('mountpoint',['-q','/mnt/ainvr-ssd']);
const root='/mnt/ainvr-ssd/ainvr-rollback/review-policy',backup=root+'/'+new Date().toISOString().replace(/[:.]/g,'-');
await mkdir(backup,{recursive:true,mode:0o700});await copyFile(path,backup+'/review-authorization.json');
if(await readFile(path,'utf8')!==before)throw Error('Concurrent authorization edit');
const temp=path+'.paired-'+process.pid;
await writeFile(temp,JSON.stringify(next,null,2)+'\n',{mode:info.mode&0o777,flag:'wx'});
await chown(temp,info.uid,info.gid);
await chmod(temp,info.mode&0o777);
await rename(temp,path);
// Keep three reversible policy snapshots on SSD, never prune elsewhere.
const entries=(await readdir(root,{withFileTypes:true})).filter(x=>x.isDirectory()&&!x.isSymbolicLink()).map(x=>x.name).sort();
for(const name of entries.slice(0,-3)){
 const target=resolve(root,name);if(dirname(target)!==root)throw Error('Unsafe backup path');
 await rm(target,{recursive:true});
}
console.log('Applied; backup: '+backup);

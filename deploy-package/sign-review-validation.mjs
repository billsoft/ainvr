import {readFile,writeFile} from 'node:fs/promises';
import {createHash,sign,createPrivateKey} from 'node:crypto';
import {REVIEW_PROMPT_VERSION} from '../alarm-service/src/review-prompt.mjs';
const [reportPath,acceptancePath,keyPath,output]=process.argv.slice(2);
if(!output)throw Error('Usage: node sign-review-validation.mjs report.json acceptance.json private-key.pem new-envelope.json');
const bytes=await readFile(reportPath),report=JSON.parse(bytes),accept=JSON.parse(await readFile(acceptancePath,'utf8'));
const sha=createHash('sha256').update(bytes).digest('hex');
if(accept.report_sha256!==sha||accept.approved!==true||accept.dataset_independent!==true||typeof accept.reviewer!=='string'||!accept.reviewer.trim())throw Error('Explicit signed-off dataset/report acceptance required');
if(report.schema!=='ainvr.review-score.v1'||report.caller_template!==REVIEW_PROMPT_VERSION||report.errors?.length||!report.results?.length)throw Error('Incomplete or obsolete report');
const test=report.results.filter(x=>x.split==='test'),models=new Set(test.map(x=>x.model?.package_sha256)),templates=new Set(test.map(x=>x.template));
const labels=[...new Set(test.map(x=>x.label))];
const t=report.thresholds;if(!t||!Number.isFinite(t.reject_below)||!Number.isFinite(t.approve_above)||typeof t.version!=='string'||!t.version||t.reject_below<0||t.approve_above>1||t.reject_below>=t.approve_above)throw Error('Invalid thresholds');
if(models.size!==1||templates.size!==1||![...models][0]?.match(/^[a-f0-9]{64}$/))throw Error('Mixed model/template');
// Count independent groups, not multiple correlated frames as independent samples.
for(const label of labels)for(const truth of [true,false]){
 const rows=test.filter(x=>x.label===label&&x.visual_label===truth);
 if(new Set(rows.map(x=>x.group)).size<100)throw Error('Need at least 100 independent positive and negative test groups per label');
 if(rows.some(x=>!Number.isFinite(x.real_score)||(truth?x.real_score<=t.reject_below:x.real_score>=t.approve_above)))throw Error('Incorrect automatic decisions in holdout');
}
if(!labels.length)throw Error('No holdout');
const splitGroups=new Map(),splitImages=new Map();for(const x of report.results){for(const [map,k] of [[splitGroups,x.group],[splitImages,x.sha256]]){if(!k||map.has(k)&&map.get(k)!==x.split)throw Error('Split leakage');map.set(k,x.split);}}
const expires=Date.parse(accept.expires_at);if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+90*86400000)throw Error('Expiry must be within 90 days');
const payload=JSON.stringify({schema:'ainvr.review-validation.v1',decision:'approved',report_sha256:sha,dataset:{independent:true,samples:new Set(test.map(x=>x.group)).size},expires_at:accept.expires_at,model_sha256:[...models][0],layout:'target-crop-v1',prompt_template:[...templates][0],caller_template:REVIEW_PROMPT_VERSION,labels,thresholds:t});
const key=createPrivateKey(await readFile(keyPath));if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 key required');
await writeFile(output,JSON.stringify({version:1,payload,signature:sign(null,Buffer.from(payload),key).toString('base64')},null,2),{flag:'wx',mode:0o600});
console.log('Qualification written; not installed. Retain report, acceptance and public key for audit.');

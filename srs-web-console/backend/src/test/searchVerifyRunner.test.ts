import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { SearchVerifyRunner } from '../services/searchVerifyRunner.js';
import { SearchVerifyLlmError, type SearchVerifyLlmPort } from '../services/searchVerifyLlm.js';
import { searchVerificationProfileFingerprint, type SearchVerificationProfile, type SearchVerificationTarget,
  type SearchVerificationBinding, type SearchVerificationInspection, type SearchVerificationMutation,
  type SearchVerificationAttempt, type SearchVerificationView, type SearchVerificationResult } from '../services/searchVerificationContract.js';
import type { SearchJob } from '../store/searchJobs.js';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const query = '红色外套的人', jpeg = Buffer.from([255,216,0,255,217]);
function profile(): SearchVerificationProfile {
  const p = { task_id: 'search-verify-zh-v1' as const, template_sha256: 'a'.repeat(64), preprocessing_version: 'test-preprocessing-v1',
    decision_policy: 'abc-visible-v1' as const, model_package_id: 'qwen3vl-4b-review-v3', model_package_sha256: 'b'.repeat(64) };
  return { ...p, profile_fp: searchVerificationProfileFingerprint(p) };
}
function fixture(count = 1) {
  const p = profile(), actor = 'operator', search = randomUUID(), channel = randomUUID(), expires = Date.now() + 600000;
  const scope = { channel_ids: [channel], from: new Date(Date.now()-10000).toISOString(), to: new Date().toISOString() };
  const refs: SearchVerificationTarget[] = Array.from({length: count}, () => ({ actor, search_id: search, version: 'c'.repeat(64), sample_id: randomUUID() }));
  const bindings = new Map(refs.map(target => [target.sample_id, { ...target, frame_id: randomUUID(), fingerprint: 'd'.repeat(64),
    query_sha256: sha(query), jpeg_sha256: sha(jpeg), profile_fp: p.profile_fp, question_scope: 'visible' as const }]));
  const entries = new Map<string, {view: SearchVerificationView; attempt: SearchVerificationAttempt | null}>();
  const saved = new Map<string, SearchJob>(), byKey = new Map<string,string>(); let cancelled = false, hasAccess = true, enabled = true;
  const mutation = (status: SearchVerificationMutation['status'], stored: boolean, id: string): SearchVerificationMutation => ({ status, stored,
    verification: entries.get(id)?.view ?? null, submitted: entries.get(id)?.attempt ?? null });
  const native = {
    scanVerification: vi.fn(async () => ({ refs: cancelled ? [] : refs.slice(0,5).filter(t=>!entries.has(t.sample_id)),
      cleanup_refs: cancelled ? refs.filter(t=>!!entries.get(t.sample_id)?.attempt).slice(0,5) : [], next_cursor: null })),
    inspectVerification: vi.fn(async (target: SearchVerificationTarget): Promise<SearchVerificationInspection> => {
      const binding = bindings.get(target.sample_id)!, entry = entries.get(target.sample_id);
      if (cancelled) return { status: 'cancelled', binding: entry?.attempt ? binding : null, submitted: entry?.attempt ?? null,
        verification: entry?.attempt ? entry.view : null, query:null,kind:null,scope:null,expires_ms:null };
      if (entry?.attempt) return { status:'submitted',binding,submitted:entry.attempt,verification:entry.view,query:null,kind:null,scope:null,expires_ms:null };
      return { status: entry && !['queued','running'].includes(entry.view.state) ? 'final' : 'pending', binding,
        query,kind:'object',scope,expires_ms:expires,verification:entry?.view??null,submitted:entry?.attempt??null };
    }),
    queueVerification: vi.fn(async (b: SearchVerificationBinding, jobId: string, generation: number): Promise<SearchVerificationMutation> => {
      const entry=entries.get(b.sample_id); if(entry?.attempt)return mutation('already_submitted',false,b.sample_id);
      if(entry && !['queued','running'].includes(entry.view.state))return mutation('final',false,b.sample_id);
      entries.set(b.sample_id,{view:{state:'queued',profile_fp:b.profile_fp,request_id:null,cached:false,reason:null},attempt:null});
      return mutation('queued',true,b.sample_id);
    }),
    beginVerification: vi.fn(async (b:SearchVerificationBinding,jobId:string,generation:number,requestId:string):Promise<SearchVerificationMutation>=>{
      const entry=entries.get(b.sample_id)!; if(entry.attempt)return mutation('already_submitted',false,b.sample_id);
      entry.attempt={job_id:jobId,generation,request_id:requestId};entry.view={...entry.view,state:'running',request_id:requestId};return mutation('submit',true,b.sample_id);
    }),
    finishVerification:vi.fn(async(b:SearchVerificationBinding,_job:string,_gen:number,requestId:string):Promise<SearchVerificationMutation>=>{
      const entry=entries.get(b.sample_id)!;entry.attempt=null;entry.view={...entry.view,state:'match',request_id:requestId,reason:'visible_evidence'};return mutation('final',true,b.sample_id);
    }),
    abortVerification:vi.fn(async(b:SearchVerificationBinding,_job:string,_gen:number,requestId:string|null,reason:string):Promise<SearchVerificationMutation>=>{
      const entry=entries.get(b.sample_id);if(!entry || entry.view.request_id!==requestId)return mutation('stale',false,b.sample_id);
      entry.attempt=null;entry.view={...entry.view,state:'unavailable',reason};return mutation('final',true,b.sample_id);
    }),
    searchImage:vi.fn(async()=>jpeg),
  };
  const jobs = {
    enqueue:vi.fn(async(owner:string,key:string,kind:string,payload:unknown)=>{
      if(byKey.has(key))return saved.get(byKey.get(key)!)!;
      const job:SearchJob={id:randomUUID(),actor:owner,kind:kind as 'verify',payload,state:'pending',generation:0,attempts:0,lease_owner:null,lease_until:null,expires_at:new Date(expires)};
      saved.set(job.id,job);byKey.set(key,job.id);return job;
    }),
    claim:vi.fn(async(worker:string)=>{const job=[...saved.values()].find(j=>j.state==='pending');if(!job)return null;
      job.state='running';job.generation++;job.attempts++;job.lease_owner=worker;job.lease_until=new Date(Date.now()+30000);return job;}),
    retryUnsubmittedVerification:vi.fn(async(id:string,owner:string,generation:number)=>{const job=saved.get(id);
      if(!job||job.actor!==owner||job.generation!==generation||job.state!=='failed'||job.error_code!=='profile_changed')return null;
      job.state='pending';job.generation++;job.attempts=0;job.error_code=null;return job;}),
    get:vi.fn(async(id:string)=>saved.get(id)??null),renew:vi.fn(async()=>true),
    finish:vi.fn(async(id:string,_worker:string,_generation:number,outcome:{resultRef?:string;errorCode?:string})=>{const job=saved.get(id)!;
      job.state=outcome.errorCode?'failed':'succeeded';job.error_code=outcome.errorCode??null;job.lease_owner=null;job.lease_until=null;return true;}),
    cancel:vi.fn(async()=>true),
  };
  const llm={profile:vi.fn(async():Promise<SearchVerificationProfile|null>=>p),cancel:vi.fn(async()=>true),
    verify:vi.fn(async(_input:Parameters<SearchVerifyLlmPort['verify']>[0]):Promise<SearchVerificationResult>=>({} as never))};
  const channels=vi.fn(async()=>hasAccess?[{id:channel}]:[]);
  const runner=()=>new SearchVerifyRunner({native:native as never,jobs:jobs as never,llm,channels,enabled:async()=>enabled,heartbeatMs:100});
  return {p,actor,search,refs,bindings,entries,saved,jobs,native,llm,channels,runner,setCancelled:(v:boolean)=>{cancelled=v;},setAccess:(v:boolean)=>{hasAccess=v;},setEnabled:(v:boolean)=>{enabled=v;}};
}
it('queues only the first five references and serially processes one PG lease per tick without storing images or query text',async()=>{
  const f=fixture(8),runner=f.runner();for(let i=0;i<6;i++)await runner.tick();
  expect(f.saved.size).toBe(5);expect(f.llm.verify).toHaveBeenCalledTimes(5);expect(f.native.finishVerification).toHaveBeenCalledTimes(5);
  expect(f.jobs.claim).toHaveBeenCalledWith(expect.any(String),'verify',30000,undefined,undefined,expect.any(Array));
  for(const job of f.saved.values()){expect(job.state).toBe('succeeded');const payload=JSON.stringify(job.payload);expect(payload).not.toContain(query);expect(payload).not.toContain(jpeg.toString('base64'));
    expect(Object.keys(job.payload as object).sort()).toEqual(['frame_id','profile','query_sha256','sample_fingerprint','sample_id','schema_version','search_id','search_version','task']);}
  await runner.stop();
});
it('never invokes a denied source or a disabled search service',async()=>{
  const f=fixture(),r=f.runner();f.setAccess(false);await r.tick();expect(f.jobs.enqueue).not.toHaveBeenCalled();expect(f.llm.verify).not.toHaveBeenCalled();
  f.setEnabled(false);f.llm.profile.mockClear();await r.tick();expect(f.llm.profile).not.toHaveBeenCalled();await r.stop();
});
it('requires exact JPEG content after ownership lookup before inference',async()=>{
  const f=fixture(),r=f.runner();f.native.searchImage.mockResolvedValue(Buffer.from([255,216,1,255,217]));await r.tick();
  expect(f.llm.verify).not.toHaveBeenCalled();expect(f.native.abortVerification).toHaveBeenCalledWith(expect.anything(),expect.any(String),1,null,'evidence_unavailable');await r.stop();
});
it('checks that the PG lease is still live immediately before the durable native submit marker',async()=>{
  const f=fixture(),r=f.runner();f.jobs.renew.mockResolvedValueOnce(false);await r.tick();
  expect(f.native.beginVerification).not.toHaveBeenCalled();expect(f.llm.verify).not.toHaveBeenCalled();expect(f.native.abortVerification).toHaveBeenCalledWith(expect.anything(),expect.any(String),1,null,'job_expired');await r.stop();
});
it('exposes only observed task readiness for nonblocking initial candidate polling',async()=>{
  const f=fixture(),r=f.runner();expect(r.currentAvailability()).toEqual({available:null,reason:null});
  f.llm.profile.mockResolvedValueOnce(null);await r.tick();expect(r.currentAvailability()).toEqual({available:false,reason:'model_unavailable'});
  await r.tick();expect(r.currentAvailability()).toEqual({available:true,reason:null});await r.stop();
});
it('does not re-submit when the durable begin reply is lost',async()=>{
  const f=fixture(),r=f.runner(),original=f.native.beginVerification.getMockImplementation()!;
  f.native.beginVerification.mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost begin ACK');});
  await r.tick();expect(f.llm.verify).not.toHaveBeenCalled();expect(f.llm.cancel).toHaveBeenCalled();expect(f.entries.get(f.refs[0]!.sample_id)!.view.state).toBe('unavailable');
  await r.tick();expect(f.llm.verify).not.toHaveBeenCalled();await r.stop();
});
it('does not recompute after an unknown LLM outcome and cancels the exact request',async()=>{
  const f=fixture(),r=f.runner();f.llm.verify.mockRejectedValueOnce(new SearchVerifyLlmError('request_timeout'));
  await r.tick();await r.tick();expect(f.llm.verify).toHaveBeenCalledTimes(1);const input=f.llm.verify.mock.calls[0]![0] as {requestId:string};
  expect(f.llm.cancel).toHaveBeenCalledWith(input.requestId,expect.any(AbortSignal));expect(f.native.finishVerification).not.toHaveBeenCalled();await r.stop();
});
it('a replacement PG lease cancels the original submitted attempt instead of running it again',async()=>{
  const f=fixture(),r=f.runner();f.jobs.claim.mockResolvedValueOnce(null);await r.tick();
  const job=[...f.saved.values()][0]!,b=f.bindings.get(f.refs[0]!.sample_id)!;job.generation=1;
  f.entries.set(b.sample_id,{view:{state:'running',profile_fp:f.p.profile_fp,request_id:'old-request',cached:false,reason:null},attempt:{job_id:job.id,generation:1,request_id:'old-request'}});
  await r.tick();expect(f.llm.verify).not.toHaveBeenCalled();expect(f.llm.cancel).toHaveBeenCalledWith('old-request',expect.any(AbortSignal));expect(job.state).toBe('failed');await r.stop();
});
it('cancelled-session scan recovers old submitted IDs after a runner restart without enqueueing work',async()=>{
  const f=fixture(),b=f.bindings.get(f.refs[0]!.sample_id)!;f.entries.set(b.sample_id,{view:{state:'running',profile_fp:f.p.profile_fp,request_id:'pre-restart',cached:false,reason:null},attempt:{job_id:randomUUID(),generation:1,request_id:'pre-restart'}});
  f.setCancelled(true);const r=f.runner();await r.tick();expect(f.jobs.enqueue).not.toHaveBeenCalled();expect(f.llm.verify).not.toHaveBeenCalled();
  expect(f.llm.cancel).toHaveBeenCalledWith('pre-restart',expect.any(AbortSignal));expect(f.native.abortVerification).toHaveBeenCalled();await r.stop();
});
it('failed cancellation retains durable submitted proof for later recovery',async()=>{
  const f=fixture(),b=f.bindings.get(f.refs[0]!.sample_id)!;f.entries.set(b.sample_id,{view:{state:'running',profile_fp:f.p.profile_fp,request_id:'still-unknown',cached:false,reason:null},attempt:{job_id:randomUUID(),generation:1,request_id:'still-unknown'}});
  f.setCancelled(true);f.llm.cancel.mockRejectedValueOnce(Error('offline'));const r=f.runner();await r.tick();expect(f.native.abortVerification).not.toHaveBeenCalled();
  expect(f.entries.get(b.sample_id)!.attempt?.request_id).toBe('still-unknown');await r.tick();expect(f.native.abortVerification).toHaveBeenCalledTimes(1);await r.stop();
});
it.each(['cancel','abort'])('a terminal PG job with a lost %s ACK is recovered from submitted metadata without another inference',async hop=>{
  const f=fixture(),r=f.runner();f.llm.verify.mockRejectedValueOnce(new SearchVerifyLlmError('request_timeout'));
  if(hop==='cancel')f.llm.cancel.mockRejectedValueOnce(Error('cancel network failure'));
  else f.native.abortVerification.mockRejectedValueOnce(Error('abort network failure'));
  await r.tick();const target=f.refs[0]!;expect(f.entries.get(target.sample_id)!.attempt).not.toBeNull();expect([...f.saved.values()][0]!.state).toBe('failed');
  f.native.scanVerification.mockImplementation(async()=>({refs:[],cleanup_refs:[target],next_cursor:null}));
  await r.tick();expect(f.llm.verify).toHaveBeenCalledTimes(1);expect(f.entries.get(target.sample_id)!.view.state).toBe('unavailable');
  expect(f.jobs.get).toHaveBeenCalledWith(expect.any(String),f.actor,true);await r.stop();
});
it('recovery metadata cannot cancel a live lease owned by another process, but an expired lease permits exact cleanup',async()=>{
  const f=fixture(),b=f.bindings.get(f.refs[0]!.sample_id)!,jobId=randomUUID();
  const job:SearchJob={id:jobId,actor:f.actor,kind:'verify',payload:{},state:'running',generation:1,attempts:1,lease_owner:randomUUID(),lease_until:new Date(Date.now()+30000),expires_at:new Date(Date.now()+60000)};
  f.saved.set(jobId,job);f.entries.set(b.sample_id,{view:{state:'running',profile_fp:f.p.profile_fp,request_id:'another-process',cached:false,reason:null},attempt:{job_id:jobId,generation:1,request_id:'another-process'}});
  f.native.scanVerification.mockImplementation(async()=>({refs:[],cleanup_refs:[f.refs[0]!],next_cursor:null}));
  const r=f.runner();await r.tick();expect(f.llm.cancel).not.toHaveBeenCalled();expect(f.native.abortVerification).not.toHaveBeenCalled();
  job.lease_until=new Date(Date.now()-1000);await r.tick();expect(f.llm.cancel).toHaveBeenCalledWith('another-process',expect.any(AbortSignal));
  expect(f.entries.get(b.sample_id)!.view.state).toBe('unavailable');expect(f.llm.verify).not.toHaveBeenCalled();await r.stop();
});
it('a profile change after inference prevents storing a stale result',async()=>{
  const f=fixture(),r=f.runner();const changed={...f.p,model_package_sha256:'e'.repeat(64)};changed.profile_fp=searchVerificationProfileFingerprint(changed);
  f.llm.profile.mockResolvedValueOnce(f.p).mockResolvedValueOnce(changed);await r.tick();expect(f.native.finishVerification).not.toHaveBeenCalled();
  expect(f.native.abortVerification).toHaveBeenCalledWith(expect.anything(),expect.any(String),1,expect.any(String),'profile_changed');await r.stop();
});
it('the exact cached reference is adopted without claiming a new neural inference',async()=>{
  const f=fixture(),r=f.runner(),original=f.native.queueVerification.getMockImplementation()!;
  f.native.queueVerification.mockImplementationOnce(async(...args)=>{await original(...args);const b=args[0];f.entries.set(b.sample_id,{view:{state:'match',profile_fp:f.p.profile_fp,request_id:'original-cached-request',cached:true,reason:'visible_evidence'},attempt:null});
    return {stored:true,status:'final',verification:f.entries.get(b.sample_id)!.view,submitted:null};});
  await r.tick();expect(f.llm.verify).not.toHaveBeenCalled();expect([...f.saved.values()][0]!.state).toBe('succeeded');await r.stop();
});
it('revoked permissions after a cache adoption still prohibit image access or new inference',async()=>{
  const f=fixture(),r=f.runner(),original=f.native.queueVerification.getMockImplementation()!;
  f.native.queueVerification.mockImplementationOnce(async(...args)=>{await original(...args);const b=args[0];f.entries.set(b.sample_id,{view:{state:'match',profile_fp:f.p.profile_fp,request_id:'cached-before-revocation',cached:true,reason:'visible_evidence'},attempt:null});
    f.setAccess(false);return {stored:true,status:'final',verification:f.entries.get(b.sample_id)!.view,submitted:null};});
  await r.tick();expect(f.llm.verify).not.toHaveBeenCalled();expect(f.native.searchImage).not.toHaveBeenCalled();
  expect([...f.saved.values()][0]!.error_code).toBe('scope_denied');await r.stop();
});
it('concurrent wake/tick calls share a single in-flight loop rather than adding a second queue',async()=>{
  const f=fixture(),r=f.runner();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});f.llm.verify.mockImplementationOnce(async()=>{await wait;return {} as never;});
  const one=r.tick();for(let i=0;i<30 && !f.llm.verify.mock.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
  const two=r.tick();expect(two).toBe(one);expect(f.llm.verify).toHaveBeenCalledTimes(1);release();await one;await r.stop();
});
it('the idle timer is rate limited and stops completely instead of busy-polling profiles',async()=>{
  vi.useFakeTimers();const f=fixture(0),r=f.runner();
  try {
    r.start();await vi.advanceTimersByTimeAsync(0);expect(f.llm.profile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);expect(f.llm.profile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(f.llm.profile).toHaveBeenCalledTimes(2);
    await r.stop();await vi.advanceTimersByTimeAsync(10000);expect(f.llm.profile).toHaveBeenCalledTimes(2);
  } finally { await r.stop();vi.useRealTimers(); }
});
it('permission revocation while inference is pending cancels the remote request and never publishes',async()=>{
  const f=fixture(),r=f.runner();f.llm.verify.mockImplementationOnce(async(raw)=>new Promise((_,reject)=>{const input=raw as {signal:AbortSignal};input.signal.addEventListener('abort',()=>reject(new SearchVerifyLlmError('cancelled')),{once:true});}));
  const active=r.tick();for(let i=0;i<30&&!f.llm.verify.mock.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
  f.setAccess(false);await active;expect(f.native.finishVerification).not.toHaveBeenCalled();expect(f.llm.cancel).toHaveBeenCalled();await r.stop();
});
it('closing the runner cancels and waits for its sole active task',async()=>{
  const f=fixture(),r=f.runner();f.llm.verify.mockImplementationOnce(async(raw)=>new Promise((_,reject)=>{(raw as {signal:AbortSignal}).signal.addEventListener('abort',()=>reject(new SearchVerifyLlmError('cancelled')),{once:true});}));
  const active=r.tick();for(let i=0;i<30&&!f.llm.verify.mock.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,1));
  await r.stop();await active;expect(f.llm.cancel).toHaveBeenCalled();expect(f.native.finishVerification).not.toHaveBeenCalled();
});

it.each(['null','timeout'])('does not claim or poison queued work when the profile is temporarily %s',async failure=>{
  const f=fixture(2),r=f.runner();await r.tick();
  const pending=[...f.saved.values()].find(j=>j.state==='pending')!;
  if(failure==='null')f.llm.profile.mockResolvedValueOnce(null);else f.llm.profile.mockRejectedValueOnce(Error('profile timeout'));
  f.jobs.claim.mockClear();await r.tick();expect(f.jobs.claim).not.toHaveBeenCalled();
  expect(pending.state).toBe('pending');expect(f.native.abortVerification).not.toHaveBeenCalled();
  await r.tick();expect(pending.state).toBe('succeeded');expect(f.llm.verify).toHaveBeenCalledTimes(2);await r.stop();
});
it('recovers a legacy profile failure only after durable native inspection proves no submission',async()=>{
  const f=fixture(),r=f.runner();f.jobs.claim.mockResolvedValueOnce(null);
  f.native.queueVerification.mockRejectedValueOnce(Error('native queue failed before write'));await r.tick();
  const job=[...f.saved.values()][0]!;job.state='failed';job.generation=1;job.error_code='profile_changed';
  await r.tick();expect(f.jobs.retryUnsubmittedVerification).toHaveBeenCalledWith(job.id,f.actor,1);
  expect(job.state).toBe('succeeded');expect(job.generation).toBe(3);expect(f.llm.verify).toHaveBeenCalledOnce();await r.stop();
});
it('never reopens a failed verification whose native record has an unknown submission',async()=>{
  const f=fixture(),r=f.runner();f.jobs.claim.mockResolvedValueOnce(null);await r.tick();
  const job=[...f.saved.values()][0]!,b=f.bindings.get(f.refs[0]!.sample_id)!;
  job.state='failed';job.error_code='profile_changed';job.generation=1;
  f.entries.set(b.sample_id,{view:{state:'running',profile_fp:f.p.profile_fp,request_id:'unknown-request',cached:false,reason:null},
    attempt:{job_id:job.id,generation:1,request_id:'unknown-request'}});
  f.native.scanVerification.mockResolvedValueOnce({refs:f.refs,cleanup_refs:[],next_cursor:null});
  await r.tick();expect(f.jobs.retryUnsubmittedVerification).not.toHaveBeenCalled();expect(f.llm.verify).not.toHaveBeenCalled();await r.stop();
});
it('drains ready work using bounded immediate turns and waits only after the queue is idle',async()=>{
  vi.useFakeTimers();const f=fixture(5),r=f.runner();
  try{r.start();await vi.advanceTimersByTimeAsync(10);expect(f.llm.verify).toHaveBeenCalledTimes(5);
    const scans=f.llm.profile.mock.calls.length;expect(scans).toBe(11);
    await vi.advanceTimersByTimeAsync(1900);expect(f.llm.profile).toHaveBeenCalledTimes(scans);
    expect(f.jobs.claim.mock.calls.map(call=>call[5])).toEqual([[],[f.actor],[f.actor],[f.actor],[f.actor],[f.actor]]);
  }finally{await r.stop();vi.useRealTimers();}
});
it.each(['null','timeout'])('retains a completed inference across a temporary post-inference profile %s',async failure=>{
  vi.useFakeTimers();const f=fixture(),r=f.runner();
  f.llm.profile.mockResolvedValueOnce(f.p);
  if(failure==='null')f.llm.profile.mockResolvedValueOnce(null);else f.llm.profile.mockRejectedValueOnce(Error('temporary profile timeout'));
  try{const pending=r.tick();await vi.advanceTimersByTimeAsync(1000);
    expect(f.llm.verify).toHaveBeenCalledOnce();expect(f.native.finishVerification).not.toHaveBeenCalled();
    expect(f.jobs.renew).toHaveBeenCalled();expect(f.native.abortVerification).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);await pending;
    expect(f.llm.verify).toHaveBeenCalledOnce();expect(f.native.finishVerification).toHaveBeenCalledOnce();
    expect([...f.saved.values()][0]!.state).toBe('succeeded');
  }finally{await r.stop();vi.useRealTimers();}
});

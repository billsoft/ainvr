import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {searchModelMigrationFingerprint} from '../services/searchModelMigrationContract.js';
import { SearchNativeClient, type NativeMigrationSample } from '../services/searchNativeClient.js';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const hash = 'a'.repeat(64), source = `search-v1-${hash}`;
const at = Date.now() - 1000;
const scope = { channel_ids: [id(1)], from: new Date(at - 1).toISOString(), to: new Date(at + 1).toISOString() };
const config = { baseUrl: 'http://127.0.0.1:8400', apiToken: 't'.repeat(48), timeoutMs: 1000 };
const jpeg = Buffer.from([255, 216, 0, 1, 2, 255, 217]);
const sample: NativeMigrationSample = { id: id(2), channel_id: id(1), processor_id: 'processor', stream_session_id: 'session',
  track_id: 'track', model_version: source, captured_ms: at, kind: 'object', expires_ms: at + 60000,
  fingerprint: 'b'.repeat(64), ordinal: '9007199254740993', jpeg_sha256: createHash('sha256').update(jpeg).digest('hex'),
  evidence: { schema_version: '1.0', source_input_id: id(3), output_channel_id: id(1), recording_channel_id: id(1),
    stream_session_id: 'session', source_pts_ns: '1234', source_frame_index: '2', frame_id: id(4),
    frame_width: 1920, frame_height: 1080, role: 'match' } };
const profile = { package_id: 'siglip2-base-full-int8', package_sha256: hash, model_version: source, dimensions: 768,
  input_spec_version: 'area;RGB;round-u8;[-1,1];squash256', files_verified: true, production_approval_declared: false, pruned: false, runtime_ready: false };
function fixture(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  return { client: new SearchNativeClient(async () => config, fetcher), fetcher };
}
const page = { source_model: source, through: '9007199254740999', items: [sample], next_cursor: sample.ordinal, exhausted: false };
describe('model migration native fixed ports', () => {
  it('reads explicit ingress capability without promoting incomplete code to runtime readiness',async()=>{
    const capabilities={implemented:true,source_ingestion_gate:false,target_write:true,artifacts:true},f=fixture(capabilities);
    expect(await f.client.migrationCapabilities()).toEqual(capabilities);
    expect(String(f.fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/model-migrations/capabilities');
    expect(f.fetcher.mock.calls[0]![1]!.method).toBe('GET');expect(f.fetcher.mock.calls[0]![1]!.headers).toEqual({'x-service-token':config.apiToken});
    for(const body of [{implemented:true,target_write:true,artifacts:true},{...capabilities,source_ingestion_gate:'true'},{...capabilities,path:'/private'}])
      await expect(fixture(body).client.migrationCapabilities()).rejects.toMatchObject({code:'invalid_response'});
  });
  it('verifies a metadata-only package identity without treating file verification as runtime ready', async () => {
    const f = fixture(profile); expect(await f.client.verifyMigrationModel(profile.package_id)).toEqual(profile);
    expect(String(f.fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/models/verify');
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ package_id: profile.package_id });
    for (const patch of [{ runtime_ready: true }, { package_sha256: 'c'.repeat(64) }, { package_id: 'other' }, { path: '/models/private' }])
      await expect(fixture({ ...profile, ...patch }).client.verifyMigrationModel(profile.package_id)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('keeps watermark beyond JS safe integer as a canonical bounded string', async () => {
    const f = fixture({ source_model: source, high_watermark: sample.ordinal });
    expect(await f.client.migrationWatermark(source, scope)).toBe(sample.ordinal);
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ source_model: source,
      scope: { channel_ids: scope.channel_ids, from_ms: at - 1, to_ms: at + 1 } });
    for (const bad of ['01', '9223372036854775808', 9007199254740992])
      await expect(fixture({ source_model: source, high_watermark: bad }).client.migrationWatermark(source, scope)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('reads actual retained history extent for up to1024 sources without deriving it from retention',async()=>{
    const extent={source_model:source,from_ms:at-1,to_ms:at+1,high_watermark:sample.ordinal};
    const f=fixture(extent);expect(await f.client.migrationExtent(source,[id(1)])).toEqual(extent);
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({source_model:source,channel_ids:[id(1)]});
    expect(await fixture({source_model:source,from_ms:null,to_ms:null,high_watermark:'0'}).client.migrationExtent(source,[id(1)]))
      .toEqual({source_model:source,from_ms:null,to_ms:null,high_watermark:'0'});
    for(const patch of [{to_ms:null},{to_ms:at-2},{high_watermark:'0'}])
      await expect(fixture({...extent,...patch}).client.migrationExtent(source,[id(1)])).rejects.toMatchObject({code:'invalid_response'});
  });
  it('reads at most32 real metadata rows with frozen model/scope/fingerprint/hash and forward-only cursor', async () => {
    const f = fixture(page); expect(await f.client.scanMigration(source, scope, null, page.through)).toEqual(page);
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ source_model: source, scope: { channel_ids: scope.channel_ids, from_ms: at - 1, to_ms: at + 1 }, after: null, through: page.through, limit: 32 });
    const variants = [{ ...page, through: '1' }, { ...page, items: [sample, sample] }, { ...page, items: [{ ...sample, fingerprint: undefined }] },
      { ...page, items: [{ ...sample, channel_id: id(9) }] }, { ...page, items: [{ ...sample, model_version: `search-v1-${'c'.repeat(64)}` }] },
      { ...page, items: [{ ...sample, vector: [1] }] }, { ...page, items: [{ ...sample, captured_ms: at + 1 }] },
      { ...page, next_cursor: '1' }, { ...page, exhausted: true }];
    for (const value of variants) await expect(fixture(value).client.scanMigration(source, scope, null, page.through)).rejects.toMatchObject({ code: 'invalid_response' });
    const empty = { ...page, items: [], next_cursor: '10' };
    expect(await fixture(empty).client.scanMigration(source, scope, '9', page.through)).toEqual(empty);
    await expect(fixture(empty).client.scanMigration(source, scope, '10', page.through)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects oversized metadata responses and invalid requests without a second transport or retry', async () => {
    const f = fixture({ ...page, padding: 'x'.repeat(262145) });
    await expect(f.client.scanMigration(source, scope, null, page.through)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const invalid = fixture(page);
    await expect(invalid.client.scanMigration(source, scope, null, page.through, 33)).rejects.toThrow();
    await expect(invalid.client.verifyMigrationModel('../untrusted.hbm')).rejects.toThrow();
    expect(invalid.fetcher).not.toHaveBeenCalled();
  });
  it('recalls exact original JPEG via authority endpoint and verifies actual bytes rather than old vectors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }));
    const client = new SearchNativeClient(async () => config, fetcher);
    expect(await client.migrationImage(sample, scope)).toEqual(jpeg);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/samples/reencode-image');
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ sample_id: sample.id, fingerprint: sample.fingerprint, source_model: source,
      scope: { channel_ids: scope.channel_ids, from_ms: at - 1, to_ms: at + 1 } });
    await expect(client.migrationImage({ ...sample, jpeg_sha256: '0'.repeat(64) }, scope)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(await fixture({}, 404).client.migrationImage(sample, scope)).toBeNull();
  });
  it('never echoes HTTP secrets or replays a failed read', async () => {
    const f = fixture({ error: 'http://writer:password@private' }, 503);
    await expect(f.client.migrationWatermark(source, scope)).rejects.toMatchObject({ message: 'unavailable' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});

const targetProfile={...profile,package_sha256:'c'.repeat(64),model_version:`search-v1-${'c'.repeat(64)}`};
const proof={job_id:id(20),worker:id(21),generation:2,actor:'operator',payload_fingerprint:'d'.repeat(64)};
const vector=Array.from({length:768},(_,i)=>i===0?1:0);
const stored={stored:true as const,sample_id:id(22),model_version:targetProfile.model_version,fingerprint:'e'.repeat(64),ordinal:'9007199254740994',jpeg_sha256:sample.jpeg_sha256};
it('target writes send only the fixed authority proof/source hash/pin/vector and validate the bounded ACK',async()=>{
 const f=fixture(stored);expect(await f.client.migrationWriteTarget(proof,sample,targetProfile,vector)).toEqual(stored);
 expect(String(f.fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/model-migrations/write-target');
 const body=JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string);
 expect(body).toEqual({...proof,source:{sample_id:sample.id,fingerprint:sample.fingerprint,jpeg_sha256:sample.jpeg_sha256},target:{package_id:targetProfile.package_id,package_sha256:targetProfile.package_sha256,model_version:targetProfile.model_version,vector}});
 expect(JSON.stringify(body)).not.toContain(config.apiToken);expect(body).not.toHaveProperty('evidence');expect(body).not.toHaveProperty('vector');expect(Object.keys(body).sort()).toEqual(['actor','generation','job_id','payload_fingerprint','source','target','worker']);expect(body.target).not.toHaveProperty('input_spec_version');
 for(const bad of [{...stored,stored:false},{...stored,model_version:source},{...stored,ordinal:'01'},{...stored,jpeg_sha256:'0'.repeat(64)},{...stored,vector:[1]}])
 await expect(fixture(bad).client.migrationWriteTarget(proof,sample,targetProfile,vector)).rejects.toMatchObject({code:'invalid_response'});
});
it('rejects malformed target vectors, profiles, paths and authority before attempting any target write',async()=>{
 const f=fixture(stored);
 for(const v of [[],[1],Array(768).fill(0),Array(768).fill(1),[NaN,...vector.slice(1)],[Infinity,...vector.slice(1)]])
 await expect(f.client.migrationWriteTarget(proof,sample,targetProfile,v)).rejects.toMatchObject({code:'invalid_response'});
 await expect(f.client.migrationWriteTarget({...proof,url:'http://foreign'} as never,sample,targetProfile,vector)).rejects.toMatchObject({code:'invalid_response'});
 await expect(f.client.migrationWriteTarget(proof,sample,{...targetProfile,package_id:'../model'},vector)).rejects.toMatchObject({code:'invalid_response'});
 expect(f.fetcher).not.toHaveBeenCalled();
});
it('receiptfirst and reconciliation distinguish committed from unknown without inventing rejection or replaying writes',async()=>{
 for(const status of ['not_found','source_changed','replaced'] as const){const result={status,stored:false,sample_id:null,model_version:targetProfile.model_version,fingerprint:null,ordinal:null,jpeg_sha256:null};
 const f=fixture(result);expect(await f.client.migrationTargetReceipt(proof,sample,targetProfile)).toEqual(result);expect(f.fetcher).toHaveBeenCalledOnce();
 expect(String(f.fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/model-migrations/target-receipt');expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).not.toHaveProperty('vector');}
 expect(await fixture({status:'committed',...stored}).client.migrationTargetReceipt(proof,sample,targetProfile)).toEqual({status:'committed',...stored});
 await expect(fixture({status:'not_found',...stored}).client.migrationTargetReceipt(proof,sample,targetProfile)).rejects.toMatchObject({code:'invalid_response'});
 const lost=fixture({error:'api_token=private'},503);await expect(lost.client.migrationWriteTarget(proof,sample,targetProfile,vector)).rejects.toMatchObject({code:'unavailable',message:'unavailable'});expect(lost.fetcher).toHaveBeenCalledOnce();
});
it('maps only the fixed Native target capacity rejection to capacity without leaking or retrying arbitrary507 failures',async()=>{
 const f=fixture({error:'capacity_exceeded'},507);await expect(f.client.migrationWriteTarget(proof,sample,targetProfile,vector)).rejects.toMatchObject({code:'capacity'});expect(f.fetcher).toHaveBeenCalledOnce();
 await expect(fixture({error:'password@private'},507).client.migrationWriteTarget(proof,sample,targetProfile,vector)).rejects.toMatchObject({code:'unavailable'});
});
it('controls artifact work by the same active PG proof and reads snapshots by owner without caller-provided scope',async()=>{
 const status={state:'building_report',checkpoint:'9007199254740993',source_completed_through:null,target_checkpoint:'0',coverage_snapshot:{required:0,matched:0,unavailable:0},coverage_sha256:null,index_manifest_sha256:null,reason:null};
 const f=fixture(status);expect(await f.client.migrationArtifacts(proof,'start')).toEqual(status);
 expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({action:'start',...proof});
 expect(String(f.fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8400/v1/model-migrations/artifacts');
 await expect(fixture({...status,state:'ready'}).client.migrationArtifacts(proof)).rejects.toMatchObject({code:'invalid_response'});
 await expect(fixture({...status,coverage_snapshot:{required:1,matched:0,unavailable:0}}).client.migrationArtifacts(proof)).rejects.toMatchObject({code:'invalid_response'});
 const payload={schema_version:'search-reencode-v1' as const,purpose:'reencode' as const,source:{package_id:profile.package_id,package_sha256:hash,model_version:source},target:{package_id:targetProfile.package_id,package_sha256:targetProfile.package_sha256,model_version:targetProfile.model_version},scope,config_revision:'f'.repeat(64),storage_generation:'1'.repeat(64),source_high_watermark:sample.ordinal,batch_size:32,acceptance_criteria_sha256:'2'.repeat(64)};
 const job={id:proof.job_id,actor:proof.actor,kind:'rebuild' as const,payload,state:'succeeded' as const,generation:proof.generation,attempts:1,lease_owner:null,lease_until:null,expires_at:new Date(Date.now()+60000)},fp=searchModelMigrationFingerprint(payload);
 const raw={schema_version:'search-reencode-artifacts-v1',payload_fingerprint:fp,source:payload.source,target:payload.target,scope:{channel_ids:scope.channel_ids,from_ms:at-1,to_ms:at+1},source_completed_through:sample.ordinal,target_checkpoint:'1',scanned:0,encoded:0,unavailable:0,coverage_sha256:'3'.repeat(64),partitions:[],next_cursor:null};
 const read=fixture(raw);expect((await read.client.migrationArtifactPage(job,null,32)).scope).toEqual(scope);
 expect(JSON.parse(read.fetcher.mock.calls[0]![1]!.body as string)).toEqual({action:'read',job_id:job.id,generation:job.generation,actor:job.actor,payload_fingerprint:fp,after:null,limit:32});
 await expect(fixture({...raw,payload_fingerprint:'0'.repeat(64)}).client.migrationArtifactPage(job,null,32)).rejects.toMatchObject({code:'invalid_response'});
});

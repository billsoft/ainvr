import {expect,it} from 'vitest';
import type {SearchJob} from '../store/searchJobs.js';
import {SearchModelMigrationPlanArtifacts} from '../services/searchModelMigrationPlanArtifacts.js';
import {migrationPlanChild,searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,type SearchMigrationPlanPayload} from '../services/searchModelMigrationPlan.js';
import {searchModelMigrationFingerprint,type SearchModelMigrationProgress} from '../services/searchModelMigrationContract.js';
import type {SearchMigrationArtifacts} from '../services/searchModelMigrationArtifacts.js';
const hash=(s:string)=>s.repeat(64),id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const ids=Array.from({length:101},(_,n)=>id(n+1));
const spec:SearchMigrationPlanPayload={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',
 source:{package_id:'source',package_sha256:hash('a'),model_version:`search-v1-${hash('a')}`},target:{package_id:'target',package_sha256:hash('b'),model_version:`search-v1-${hash('b')}`},
 config_revision:hash('c'),storage_generation:hash('d'),acceptance_criteria_sha256:hash('e'),source_ids_sha256:searchMigrationSourceIdsDigest(ids),source_count:ids.length,
 extent:{from_ms:100000,to_ms:200000,source_high_watermark:'999'}};
function fixture() {
 const parent:SearchJob={id:id(1000),actor:'human',kind:'rebuild',payload:spec,state:'running',generation:1,attempts:1,lease_owner:id(2000),lease_until:new Date(Date.now()+30000),expires_at:new Date(Date.now()+86400000),
 migration_progress:{schema_version:'search-reencode-plan-progress-v1',payload_fingerprint:searchMigrationPlanFingerprint(spec),phase:'encoding',next_partition:2,total_children:2,aggregate_sha256:null,coverage_sha256:null,index_manifest_sha256:null}};
 const children=[0,1].map(index=>{
  const payload=migrationPlanChild(parent.id,spec,ids,index),progress:SearchModelMigrationProgress={schema_version:'search-reencode-progress-v1',payload_fingerprint:searchModelMigrationFingerprint(payload),
   phase:'awaiting_acceptance',cursor:null,scanned:9,encoded:9,unavailable:0,coverage_snapshot:{required:5,matched:5,unavailable:0},source_completed_through:'999',target_checkpoint:'1000',coverage_sha256:hash('f'),index_manifest_sha256:hash('1')};
  return {...parent,id:id(1100+index),payload,migration_progress:progress,state:'succeeded' as const,lease_owner:null,lease_until:null};
 });
 const resolve=async(child:SearchJob):Promise<SearchMigrationArtifacts>=>{
  const p=child.payload as ReturnType<typeof migrationPlanChild>,s=child.migration_progress as SearchModelMigrationProgress;
  return {report:{schema_version:'search-reencode-artifacts-v1',payload_fingerprint:s.payload_fingerprint,source:p.source,target:p.target,scope:p.scope,
   source_completed_through:'999',target_checkpoint:'1000',scanned:5,encoded:5,unavailable:0,coverage_sha256:hash('f'),partitions:[]},index_manifest_sha256:hash('1')};
 };
 return {parent,children,resolve};
}
it('independently verifies each deterministic child and binds current proofs instead of cumulative attempt sums',async()=>{
 const f=fixture(),seen:string[]=[],service=new SearchModelMigrationPlanArtifacts({resolve:async(...args)=>{seen.push(args[0].id);return f.resolve(args[0]);}});
 const proof=await service.resolve(f.parent,f.children,ids);expect(seen).toEqual(f.children.map(c=>c.id));expect(proof.children).toHaveLength(2);
 expect(proof.children[0]!.artifacts.report.scanned).toBe(5);expect((f.children[0]!.migration_progress as SearchModelMigrationProgress).scanned).toBe(9);
 expect((await service.resolve(f.parent,f.children,ids,undefined,proof,true)).aggregate_sha256).toBe(proof.aggregate_sha256);
});
it('missing, reordered, wrong actor, scope, model and changed source catalogs cannot become complete plans',async()=>{
 const f=fixture(),service=new SearchModelMigrationPlanArtifacts({resolve:f.resolve});
 await expect(service.resolve(f.parent,f.children.slice(0,1),ids)).rejects.toThrow('migration_plan_incomplete');
 await expect(service.resolve(f.parent,[...f.children].reverse(),ids)).rejects.toThrow('migration_plan_child_changed');
 await expect(service.resolve(f.parent,[{...f.children[0]!,actor:'other'},f.children[1]!],ids)).rejects.toThrow('migration_plan_child_changed');
 const changed=structuredClone(f.children);(changed[0]!.payload as ReturnType<typeof migrationPlanChild>).target=spec.source;
 await expect(service.resolve(f.parent,changed,ids)).rejects.toThrow();
 await expect(service.resolve(f.parent,f.children,[...ids.slice(0,-1),id(9000)])).rejects.toThrow('migration_source_catalog_changed');
});
it('a failed, pending, expired or changed-generation child does not inherit an earlier aggregate proof',async()=>{
 const f=fixture(),service=new SearchModelMigrationPlanArtifacts({resolve:f.resolve}),proof=await service.resolve(f.parent,f.children,ids);
 for(const state of ['failed','running','pending'] as const) await expect(service.resolve(f.parent,[{...f.children[0]!,state},f.children[1]!],ids)).rejects.toThrow('migration_plan_child_changed');
 await expect(service.resolve(f.parent,[{...f.children[0]!,expires_at:new Date(0)},f.children[1]!],ids)).rejects.toThrow('migration_plan_child_changed');
 await expect(service.resolve(f.parent,[{...f.children[0]!,generation:2},f.children[1]!],ids,undefined,proof,true)).rejects.toThrow('migration_plan_child_changed');
});
it('fresh actual artifact changes invalidate a frozen proof instead of silently counting old target data',async()=>{
 const f=fixture(),service=new SearchModelMigrationPlanArtifacts({resolve:f.resolve}),proof=await service.resolve(f.parent,f.children,ids);
 const changed=new SearchModelMigrationPlanArtifacts({resolve:async(child)=>({...await f.resolve(child),index_manifest_sha256:hash('2')})});
 await expect(changed.resolve(f.parent,f.children,ids,undefined,proof,true)).rejects.toThrow('migration_plan_artifacts_changed');
});

import {expect,it} from 'vitest';
import {searchMigrationSourceIdsDigest,searchMigrationPlanFingerprint,migrationPlanFinalSpec,migrationPlanRound,migrationPlanIngestionGate,migrationPlanChildCount,searchMigrationPlanPayloadSchema,type SearchMigrationPlanPayload,type SearchMigrationPlanProgress} from '../services/searchModelMigrationPlan.js';
const hash=(s:string)=>s.repeat(64),id=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`,now=100000;
const spec:SearchMigrationPlanPayload={schema_version:'search-reencode-plan-v1',purpose:'reencode_plan',source:{package_id:'source',package_sha256:hash('a'),model_version:`search-v1-${hash('a')}`},
 target:{package_id:'target',package_sha256:hash('b'),model_version:`search-v1-${hash('b')}`},config_revision:hash('c'),storage_generation:hash('d'),acceptance_criteria_sha256:hash('e'),source_count:1,source_ids_sha256:searchMigrationSourceIdsDigest([id(1)]),extent:{from_ms:10,to_ms:1000,source_high_watermark:'100'}};
const progress:SearchMigrationPlanProgress={schema_version:'search-reencode-plan-progress-v1',payload_fingerprint:searchMigrationPlanFingerprint(spec),phase:'quiescing',next_partition:1,total_children:1,aggregate_sha256:hash('f'),coverage_sha256:hash('1'),index_manifest_sha256:hash('2'),
 pause:{epoch:id(2),requested_at_ms:now,drained_at_ms:null,observed_extent:null},switch_deadline_ms:now+120000};
const job={id:id(3),state:'running',generation:1,lease_owner:id(4),lease_until:new Date(now+30000),expires_at:new Date(now+86400000),payload:spec,migration_progress:progress};
const current={revision:spec.config_revision,source_ids:[id(1)],active_model:spec.source};
it('human acceptance may take hours without pausing sampling and a switch gate is bounded by every real lease',()=>{
 expect(migrationPlanIngestionGate({...job,state:'succeeded',migration_progress:{...progress,phase:'awaiting_acceptance',pause:null}},current,now)).toBeNull();
 expect(migrationPlanIngestionGate(job,current,now)).toMatchObject({paused:true,epoch:id(2),expires_ms:now+30000});
 expect(migrationPlanIngestionGate({...job,lease_until:new Date(now+300000)},current,now)!.expires_ms).toBe(now+120000);
 expect(migrationPlanIngestionGate(job,current,now+30000)).toBeNull();
 for(const state of ['pending','cancelled','failed','succeeded'])expect(migrationPlanIngestionGate({...job,state},current,now)).toBeNull();
});
it('gate cannot be reused after a source, revision, physical target pin, catalog or epoch context changed',()=>{
 expect(migrationPlanIngestionGate(job,{...current,revision:hash('f')},now)).toBeNull();
 expect(migrationPlanIngestionGate(job,{...current,active_model:spec.target},now)).toBeNull();
 expect(migrationPlanIngestionGate(job,{...current,source_ids:[id(9)]},now)).toBeNull();
 expect(migrationPlanIngestionGate({...job,migration_progress:{...progress,pause:null}},current,now)).toBeNull();
});
it('a final delta freezes max waterline and full history extent while preserving immutable initial H',()=>{
 const final=migrationPlanFinalSpec(spec,{from_ms:20,to_ms:2000,high_watermark:'101'});
 expect(final.extent).toEqual({from_ms:20,to_ms:2000,source_high_watermark:'101'});expect(spec.extent.source_high_watermark).toBe('100');
 const state:SearchMigrationPlanProgress={...progress,phase:'catching_up',active_round:1,next_partition:0,final_plan:final,pause:{...progress.pause!,drained_at_ms:now+1,observed_extent:{from_ms:20,to_ms:2000,high_watermark:'101'}}};
 expect(migrationPlanRound(spec,state)).toEqual({spec:final,round:1,after:'100'});
 expect(migrationPlanFinalSpec(spec,{from_ms:null,to_ms:null,high_watermark:'0'}).extent).toEqual({from_ms:null,to_ms:null,source_high_watermark:spec.extent.source_high_watermark});
 expect(()=>migrationPlanRound(spec,{...state,pause:{...state.pause!,drained_at_ms:null}})).toThrow('migration_finalization_invalid');
 expect(()=>migrationPlanRound(spec,{...state,final_plan:{...final,storage_generation:hash('f')}})).toThrow('migration_finalization_invalid');
});

it('a final-only 120-second delta does not make an exact365-day initial history impossible to switch',()=>{
 const initial={...spec,extent:{from_ms:0,to_ms:365*86400000,source_high_watermark:'100'}};
 expect(searchMigrationPlanPayloadSchema.safeParse({...initial,extent:{...initial.extent,to_ms:initial.extent.to_ms+1}}).success).toBe(false);
 const final=migrationPlanFinalSpec(initial,{from_ms:0,to_ms:initial.extent.to_ms+120000,high_watermark:'110'});
 expect(migrationPlanChildCount(final,true)).toBeLessThanOrEqual(12);
 expect(()=>migrationPlanFinalSpec(initial,{from_ms:0,to_ms:initial.extent.to_ms+120001,high_watermark:'110'})).toThrow();
});

it('human acceptance delays do not widen retention by retaining already expired initial-prefix dates',()=>{
 const initial={...spec,extent:{from_ms:0,to_ms:365*86400000,source_high_watermark:'100'}},tenDays=10*86400000;
 const observed={from_ms:tenDays,to_ms:375*86400000,high_watermark:'1000'},final=migrationPlanFinalSpec(initial,observed);
 expect(final.extent).toEqual({from_ms:observed.from_ms,to_ms:observed.to_ms,source_high_watermark:'1000'});
 const state:SearchMigrationPlanProgress={...progress,phase:'catching_up',active_round:1,final_plan:final,pause:{...progress.pause!,drained_at_ms:now+1,observed_extent:observed}};
 expect(migrationPlanRound(initial,state).after).toBe('100');expect(migrationPlanChildCount(final,true)).toBeLessThanOrEqual(12);
});

it('an exact approved parent transition keeps ingress fenced across desired revision changes until actual target pin ACK',()=>{
 const activated={...job,migration_progress:{...progress,phase:'activated',active_round:1,published_version:2}},
 transition={job_id:job.id,generation:job.generation,payload_fingerprint:searchMigrationPlanFingerprint(spec),source:spec.source,target:spec.target};
 expect(migrationPlanIngestionGate(activated,{...current,revision:hash('e'),approved_transition:transition},now)).toMatchObject({paused:true,epoch:id(2)});
 expect(migrationPlanIngestionGate(activated,{...current,revision:hash('e'),approved_transition:{...transition,generation:99}},now)).toBeNull();
 expect(migrationPlanIngestionGate(activated,{...current,revision:hash('e'),active_model:spec.target,approved_transition:transition},now)).toBeNull();
});

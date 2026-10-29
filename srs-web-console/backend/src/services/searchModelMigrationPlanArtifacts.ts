import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {SearchJob} from '../store/searchJobs.js';
import {searchMigrationPlanPayloadSchema,searchMigrationPlanProgressSchema,searchMigrationPlanFingerprint,searchMigrationSourceIdsDigest,migrationPlanChild,migrationPlanChildCount,migrationPlanRound} from './searchModelMigrationPlan.js';
import {searchModelMigrationFingerprint,searchModelMigrationPayloadSchema,searchModelMigrationProgressSchema} from './searchModelMigrationContract.js';
import {SearchModelMigrationArtifacts,type SearchMigrationArtifacts} from './searchModelMigrationArtifacts.js';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');
export interface SearchMigrationPlanArtifacts {
  parent_id:string;parent_generation:number;payload_fingerprint:string;
  children:{id:string;generation:number;progress:unknown;artifacts:SearchMigrationArtifacts}[];
  aggregate_sha256:string;coverage_sha256:string;index_manifest_sha256:string;
}
/** Disjoint source/time partitions reuse the existing child artifact verifier.
 * This aggregates authenticated evidence proofs, never a second vector index or
 * a sum of attempted writes masquerading as current retained-history coverage. */
export class SearchModelMigrationPlanArtifacts {
  constructor(private readonly artifacts:Pick<SearchModelMigrationArtifacts,'resolve'>){}
  async resolve(parent:SearchJob,children:readonly SearchJob[],sourceIds:readonly string[],
    client?:Pick<PoolClient,'query'>,frozen?:SearchMigrationPlanArtifacts,lock=false):Promise<SearchMigrationPlanArtifacts> {
    const spec=searchMigrationPlanPayloadSchema.parse(parent.payload),progress=searchMigrationPlanProgressSchema.parse(parent.migration_progress);
    const fp=searchMigrationPlanFingerprint(spec),round=migrationPlanRound(spec,progress);
    if(sourceIds.length!==spec.source_count||searchMigrationSourceIdsDigest(sourceIds)!==spec.source_ids_sha256)
      throw new Error('migration_source_catalog_changed');
    if(progress.payload_fingerprint!==fp||progress.next_partition!==progress.total_children||children.length!==progress.total_children||children.length>132||progress.total_children!==migrationPlanChildCount(round.spec,round.round===1))
      throw new Error('migration_plan_incomplete');
    if(frozen&&(frozen.parent_id!==parent.id||frozen.parent_generation!==parent.generation||frozen.payload_fingerprint!==fp||frozen.children.length!==children.length))
      throw new Error('migration_plan_changed');
    const proofs:SearchMigrationPlanArtifacts['children']=[];
    for(let index=0;index<children.length;index++) {
      const child=children[index]!,expected=migrationPlanChild(parent.id,round.spec,sourceIds,index,round.round,round.after,parent.generation),payload=searchModelMigrationPayloadSchema.parse(child.payload);
      const state=searchModelMigrationProgressSchema.parse(child.migration_progress),prior=frozen?.children[index];
      if(child.actor!==parent.actor||child.state!=='succeeded'||child.expires_at.getTime()<=Date.now()||
        searchModelMigrationFingerprint(payload)!==searchModelMigrationFingerprint(expected)||state.payload_fingerprint!==searchModelMigrationFingerprint(expected)||
        !['awaiting_acceptance','ready'].includes(state.phase)||state.source_completed_through!==round.spec.extent.source_high_watermark||
        (prior&&(prior.id!==child.id||prior.generation!==child.generation||JSON.stringify(searchModelMigrationProgressSchema.parse(prior.progress))!==JSON.stringify(state))))
        throw new Error('migration_plan_child_changed');
      const checked=await this.artifacts.resolve(child,client,prior?.artifacts.report,lock);
      proofs.push({id:child.id,generation:child.generation,progress:state,artifacts:checked});
    }
    const tuples=proofs.map((proof,index)=>[index,proof.id,proof.generation,
      searchModelMigrationProgressSchema.parse(proof.progress).payload_fingerprint,digest(proof.artifacts.report),proof.artifacts.index_manifest_sha256]);
    const result={parent_id:parent.id,parent_generation:parent.generation,payload_fingerprint:fp,children:proofs,
      aggregate_sha256:digest(['ainvr-search-migration-plan-artifacts-v1',fp,round.round,searchMigrationPlanFingerprint(round.spec,round.round===1),tuples]),
      coverage_sha256:digest(['ainvr-search-migration-plan-coverage-v1',fp,round.round,searchMigrationPlanFingerprint(round.spec,round.round===1),proofs.map((p,index)=>[index,p.artifacts.report.coverage_sha256])]),
      index_manifest_sha256:digest(['ainvr-search-migration-plan-index-v1',fp,round.round,searchMigrationPlanFingerprint(round.spec,round.round===1),proofs.map((p,index)=>[index,p.artifacts.index_manifest_sha256])])};
    if(frozen&&(frozen.aggregate_sha256!==result.aggregate_sha256||frozen.coverage_sha256!==result.coverage_sha256||frozen.index_manifest_sha256!==result.index_manifest_sha256))
      throw new Error('migration_plan_artifacts_changed');
    return result;
  }
}

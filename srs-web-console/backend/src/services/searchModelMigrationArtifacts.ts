import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { SearchJob } from '../store/searchJobs.js';
import { sameSearchScope, searchRangeSchema } from './searchContract.js';
import { searchMigrationModelSchema, searchMigrationOrdinalSchema, searchModelMigrationPayloadSchema,
  searchModelMigrationProgressSchema, searchModelMigrationFingerprint } from './searchModelMigrationContract.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});
/** Native derives this from current retained original-JPEG provenance, not from
 * PG row counts or old embeddings. There is no browser-supplied report URL. */
const partitionSchema = z.object({ channel_id: z.string().uuid(), day, checkpoint: searchMigrationOrdinalSchema, records: integer }).strict();
const reportSchema = z.object({
  schema_version: z.literal('search-reencode-artifacts-v1'), payload_fingerprint: hash,
  source: searchMigrationModelSchema, target: searchMigrationModelSchema, scope: searchRangeSchema,
  source_completed_through: searchMigrationOrdinalSchema, target_checkpoint: searchMigrationOrdinalSchema,
  scanned: integer, encoded: integer, unavailable: integer, coverage_sha256: hash,
  partitions: z.array(partitionSchema).max(3200),
}).strict();
export const searchMigrationArtifactReportSchema = reportSchema.superRefine((value, ctx) => {
  const target=searchMigrationOrdinalSchema.safeParse(value.target_checkpoint);
  if(!target.success||value.partitions.some(part=>!searchMigrationOrdinalSchema.safeParse(part.checkpoint).success))return;
  if (value.encoded + value.unavailable !== value.scanned || value.partitions.reduce((sum, part) => sum + part.records, 0) !== value.encoded ||
      new Set(value.partitions.map(part => `${part.channel_id}/${part.day}`)).size !== value.partitions.length ||
      value.partitions.some(part => !value.scope.channel_ids.includes(part.channel_id) || part.records < 1 || BigInt(part.checkpoint) > BigInt(value.target_checkpoint) ||
        Date.parse(`${part.day}T00:00:00Z`) >= Date.parse(value.scope.to) || Date.parse(`${part.day}T00:00:00Z`) + 86400000 <= Date.parse(value.scope.from)))
    ctx.addIssue({ code: 'custom', message: 'migration_report_inconsistent' });
});
const partitionCursor = z.string().regex(/^[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}$/);
export const searchMigrationArtifactPageSchema = reportSchema.extend({ partitions: z.array(partitionSchema).max(32), next_cursor: partitionCursor.nullable() }).strict();
export type SearchMigrationArtifactReport = z.infer<typeof searchMigrationArtifactReportSchema>;
export interface SearchMigrationArtifacts { report: SearchMigrationArtifactReport; index_manifest_sha256: string }
export class SearchMigrationArtifactError extends Error {
  constructor(readonly code = 'migration_artifacts_pending') { super(code); }
}

/** The existing PG shard directory plus an actual Native report are both
 * required. Missing Native support fails closed; there is no always-ready
 * default, filesystem scan or second index publication authority. */
export class SearchModelMigrationArtifacts {
  constructor(private readonly pool: Pool,
    private readonly nativeReport: (job: SearchJob, after: string | null, limit: 32) => Promise<unknown>) {}
  private async readReport(job: SearchJob): Promise<SearchMigrationArtifactReport> {
    let after: string | null = null, header: Omit<SearchMigrationArtifactReport,'partitions'> | null = null;
    const parts: z.infer<typeof partitionSchema>[] = [];
    for(let pageIndex=0;pageIndex<100;pageIndex++) {
      const raw=await this.nativeReport(job,after,32);
      if(Buffer.byteLength(JSON.stringify(raw))>32768) throw new SearchMigrationArtifactError('migration_report_capacity');
      const {partitions,next_cursor,...current}=searchMigrationArtifactPageSchema.parse(raw);
      if(header && JSON.stringify(current)!==JSON.stringify(header)) throw new SearchMigrationArtifactError('migration_report_changed');
      header=current;
      let previous=after??'';
      for(const part of partitions) {
        const key=`${part.channel_id}/${part.day}`;
        if(key<=previous) throw new SearchMigrationArtifactError('migration_report_cursor');
        previous=key;parts.push(part);
      }
      if(parts.length>3200 || (next_cursor!==null && (next_cursor<previous || next_cursor<= (after??''))))
        throw new SearchMigrationArtifactError('migration_report_cursor');
      if(next_cursor===null) return searchMigrationArtifactReportSchema.parse({...header,partitions:parts});
      after=next_cursor;
    }
    throw new SearchMigrationArtifactError('migration_report_capacity');
  }
  async prepare(job: SearchJob, client: Pick<PoolClient, 'query'> = this.pool,
    frozenReport?: SearchMigrationArtifactReport, lock = false): Promise<SearchMigrationArtifacts> {
    const payload = searchModelMigrationPayloadSchema.parse(job.payload), progress = searchModelMigrationProgressSchema.parse(job.migration_progress);
    let report: SearchMigrationArtifactReport;
    try { report = searchMigrationArtifactReportSchema.parse(frozenReport ?? await this.readReport(job)); }
    catch { throw new SearchMigrationArtifactError(); }
    if (report.payload_fingerprint !== searchModelMigrationFingerprint(payload) ||
        JSON.stringify(report.source) !== JSON.stringify(payload.source) || JSON.stringify(report.target) !== JSON.stringify(payload.target) ||
        !sameSearchScope(report.scope, payload.scope) || report.source_completed_through !== payload.source_high_watermark ||
        (progress.target_checkpoint!==null&&BigInt(report.target_checkpoint)<BigInt(progress.target_checkpoint)))
      throw new SearchMigrationArtifactError('migration_report_changed');
    const expected = [...report.partitions].sort((a, b) => `${a.channel_id}/${a.day}`.localeCompare(`${b.channel_id}/${b.day}`));
    const artifacts: unknown[] = [];
    // At most 3,200 source/day partitions for an arbitrary 31-day interval.
    // One bounded metadata query avoids a
    // per-file/record walk and never reads JPEG/vector bytes in the parameter DB.
    const rows = (await client.query(`SELECT id,channel_id,model_version,day::text AS day,published_revision::text AS revision,
      published_storage_generation,manifest_sha256,checkpoint::text AS checkpoint,record_count,byte_count::text AS bytes,state
      FROM search_index_shards WHERE model_version=$1 AND channel_id=ANY($2::uuid[])
        AND directory_storage_generation=$3 AND storage_generation=$3 AND published_storage_generation=$3
        AND day>=($4::timestamptz AT TIME ZONE 'UTC')::date AND day<=(($5::timestamptz-interval '1 millisecond') AT TIME ZONE 'UTC')::date
      ORDER BY channel_id,day LIMIT 3201${lock ? ' FOR SHARE' : ''}`, [payload.target.model_version, payload.scope.channel_ids, payload.storage_generation, payload.scope.from, payload.scope.to])).rows;
    if (rows.length > 3200) throw new SearchMigrationArtifactError('migration_artifacts_capacity');
    const directory = new Map(rows.map(row => [`${row.channel_id}/${row.day}`, row]));
    for (const part of expected) {
      const row = directory.get(`${part.channel_id}/${part.day}`);
      if (!row || row.state !== 'ready' || !row.revision || !hash.safeParse(row.manifest_sha256).success ||
          !searchMigrationOrdinalSchema.safeParse(row.checkpoint).success || BigInt(row.checkpoint) < BigInt(part.checkpoint) ||
          !Number.isSafeInteger(row.record_count) || row.record_count < part.records)
        throw new SearchMigrationArtifactError();
      artifacts.push([row.id, row.channel_id, row.model_version, row.day, row.revision, payload.storage_generation,
        row.manifest_sha256, row.checkpoint, row.record_count, row.bytes]);
    }
    const index_manifest_sha256 = createHash('sha256').update(JSON.stringify(['ainvr-search-migration-index-v1',
      report.payload_fingerprint, report.target_checkpoint, artifacts]), 'utf8').digest('hex');
    return { report, index_manifest_sha256 };
  }
  async resolve(job:SearchJob,client:Pick<PoolClient,'query'>=this.pool,frozenReport?:SearchMigrationArtifactReport,lock=false):Promise<SearchMigrationArtifacts> {
    const artifacts=await this.prepare(job,client,frozenReport,lock),report=artifacts.report,progress=searchModelMigrationProgressSchema.parse(job.migration_progress);
    const live=progress.coverage_snapshot??{required:progress.scanned,matched:progress.encoded,unavailable:progress.unavailable};
    if(report.source_completed_through!==progress.source_completed_through||report.target_checkpoint!==progress.target_checkpoint||
      report.scanned!==live.required||report.encoded!==live.matched||report.unavailable!==live.unavailable||report.coverage_sha256!==progress.coverage_sha256)
      throw new SearchMigrationArtifactError('migration_report_changed');
    if(artifacts.index_manifest_sha256!==progress.index_manifest_sha256)throw new SearchMigrationArtifactError('migration_manifest_changed');
    return artifacts;
  }
}

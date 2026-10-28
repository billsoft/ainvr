import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
const kind = z.enum(['index', 'rebuild', 'verify']);
const uuid = z.string().uuid();
const terminalCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export class SearchJobError extends Error {}
export interface SearchJob {
  id: string; actor: string; kind: z.infer<typeof kind>; payload: unknown;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  generation: number; attempts: number; lease_owner: string | null;
  lease_until: Date | null; expires_at: Date;
}
export class SearchJobs {
  constructor(private readonly pool: Pool) {}
  async enqueue(actor: string, requestKey: string, jobKind: string, payload: unknown) {
    uuid.parse(requestKey); kind.parse(jobKind);
    if (!actor || actor.length > 128) throw new SearchJobError('invalid_actor');
    // Callers supply an already validated contract, not arbitrary URLs or paths.
    const json = JSON.stringify(payload);
    if (!json || Buffer.byteLength(json) > 12000) throw new SearchJobError('job_too_large');
    const fingerprint = createHash('sha256').update(jobKind + '\n' + json).digest('hex');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Shared admission lock: bounds remain true under concurrent enqueue.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ainvr-search-jobs',0))");
      await c.query(`DELETE FROM search_jobs WHERE id IN
        (SELECT id FROM search_jobs WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000)`);
      const old = await c.query('SELECT * FROM search_jobs WHERE actor=$1 AND request_key=$2', [actor, requestKey]);
      if (old.rows[0]) {
        if (old.rows[0].fingerprint !== fingerprint) throw new SearchJobError('idempotency_conflict');
        await c.query('COMMIT'); return old.rows[0] as SearchJob;
      }
      const count = await c.query('SELECT count(*)::int AS count FROM search_jobs');
      if (count.rows[0].count >= 1000) throw new SearchJobError('queue_full');
      const active = await c.query("SELECT count(*)::int AS count FROM search_jobs WHERE actor=$1 AND state IN ('pending','running')", [actor]);
      if (active.rows[0].count >= 32) throw new SearchJobError('actor_queue_full');
      const r = await c.query(`INSERT INTO search_jobs(id,actor,request_key,fingerprint,kind,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours') RETURNING *`,
      [randomUUID(), actor, requestKey, fingerprint, jobKind, json]);
      await c.query('COMMIT'); return r.rows[0] as SearchJob;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
  async claim(worker: string, jobKind: string, leaseMs = 30000): Promise<SearchJob | null> {
    uuid.parse(worker); kind.parse(jobKind);
    z.number().int().min(1000).max(60000).parse(leaseMs);
    // Expired final attempts are terminal, not permanently stuck as running.
    await this.pool.query(`UPDATE search_jobs SET state='failed',error_code='attempts_exhausted',
      lease_owner=NULL,lease_until=NULL WHERE state='running' AND lease_until<=now() AND attempts>=3`);
    const r = await this.pool.query(`WITH candidate AS (
      SELECT id FROM search_jobs WHERE kind=$1 AND expires_at>now() AND attempts<3
      AND (state='pending' OR (state='running' AND lease_until<=now()))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE search_jobs j SET state='running',lease_owner=$2,
      lease_until=LEAST(j.expires_at,now()+$3::int*interval '1 millisecond'),
      generation=j.generation+1,attempts=j.attempts+1
    FROM candidate c WHERE j.id=c.id RETURNING j.*`, [jobKind, worker, leaseMs]);
    return r.rows[0] ?? null;
  }
  async renew(id: string, worker: string, generation: number, leaseMs = 30000) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    z.number().int().min(1000).max(60000).parse(leaseMs);
    const r = await this.pool.query(`UPDATE search_jobs SET lease_until=LEAST(expires_at,now()+$4::int*interval '1 millisecond')
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND state='running' AND lease_until>now() AND expires_at>now()`, [id, worker, generation, leaseMs]);
    return r.rowCount === 1;
  }
  async finish(id: string, worker: string, generation: number, outcome: { resultRef: string } | { errorCode: string }) {
    uuid.parse(id); uuid.parse(worker); z.number().int().positive().parse(generation);
    const success = 'resultRef' in outcome;
    const value = success ? z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/).parse(outcome.resultRef) : terminalCode.parse(outcome.errorCode);
    const r = await this.pool.query(`UPDATE search_jobs SET state=$4,result_ref=$5,error_code=$6,lease_owner=NULL,lease_until=NULL
      WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND state='running' AND lease_until>now() AND expires_at>now()`,
    [id, worker, generation, success ? 'succeeded' : 'failed', success ? value : null, success ? null : value]);
    return r.rowCount === 1;
  }
  async cancel(id: string, actor: string) {
    uuid.parse(id);
    const r = await this.pool.query(`UPDATE search_jobs SET state='cancelled',generation=generation+1,
      lease_owner=NULL,lease_until=NULL WHERE id=$1 AND actor=$2 AND state IN ('pending','running') RETURNING id`, [id, actor]);
    return r.rowCount === 1;
  }
  async get(id: string, actor: string): Promise<SearchJob | null> {
    uuid.parse(id);
    const r = await this.pool.query('SELECT * FROM search_jobs WHERE id=$1 AND actor=$2 AND expires_at>now()', [id, actor]);
    return r.rows[0] ?? null;
  }
}

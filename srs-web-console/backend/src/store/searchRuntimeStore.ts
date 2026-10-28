import type { Pool } from 'pg';
export interface SearchRuntimeState {
  desired_version: number; revision: string; status: 'applied' | 'failed'; error_code: string | null;
}
/** One current dependency ACK, not another configuration store or history DB. */
export class SearchRuntimeStore {
  constructor(private readonly pool: Pool) {}
  async read(): Promise<SearchRuntimeState | null> {
    const result = await this.pool.query('SELECT desired_version,revision,status,error_code FROM search_runtime_state WHERE singleton=true');
    return result.rows[0] ?? null;
  }
  async acknowledge(state: SearchRuntimeState): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query("SELECT desired_version FROM config_service_states WHERE service_name='search-service' FOR UPDATE");
      if (current.rows[0]?.desired_version !== state.desired_version) { await client.query('ROLLBACK'); return false; }
      await client.query(`INSERT INTO search_runtime_state(singleton,desired_version,revision,status,error_code)
        VALUES(true,$1,$2,$3,$4) ON CONFLICT(singleton) DO UPDATE SET desired_version=EXCLUDED.desired_version,
        revision=EXCLUDED.revision,status=EXCLUDED.status,error_code=EXCLUDED.error_code,updated_at=now()`,
      [state.desired_version, state.revision, state.status, state.error_code]);
      await client.query(`UPDATE config_service_states SET status=$2::text,restart_required=false,error_message=$3,
        applied_version=CASE WHEN $2::text='applied' THEN $1 ELSE applied_version END,
        applied_at=CASE WHEN $2::text='applied' THEN now() ELSE applied_at END,last_check_at=now()
        WHERE service_name='search-service' AND desired_version=$1`,
      [state.desired_version, state.status, state.error_code ?? '']);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

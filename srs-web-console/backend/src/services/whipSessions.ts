import type { PgConfigStore } from '../store/pgStore.js';

export interface WhipSession {
  key: string;
  generation?: string;
  path: string;
  credential: string;
}

// One input owner per channel. Persist encrypted control URLs so an application
// restart does not lose the ability to revoke an already running publisher.
export class WhipSessions {
  private locks = new Map<string, Promise<void>>();
  constructor(private secrets: () => Pick<PgConfigStore, 'getSecret' | 'setSecret' | 'deleteSecret'> | null,
    private srsUrl: string) {}
  async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!this.locks.has(id) && this.locks.size >= 64)
      throw Object.assign(new Error('接入操作繁忙，请稍后重试'), { statusCode: 429 });
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(id, next);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private storage() {
    const pg = this.secrets();
    if (!pg) throw Object.assign(new Error('发布凭据存储尚未就绪'), { statusCode: 503 });
    return pg;
  }
  private key(id: string) { return `backend/ingest-session/${id}`; }
  async get(id: string): Promise<WhipSession | null> {
    const raw = await this.storage().getSecret(this.key(id));
    if (!raw) return null;
    const s = JSON.parse(raw) as WhipSession;
    if (typeof s.key !== 'string' || typeof s.credential !== 'string' || typeof s.path !== 'string' ||
      !s.path.startsWith('/rtc/v1/whip/?') || /[\r\n]/.test(s.path))
      throw Object.assign(new Error('发布会话记录无效，请检查服务日志'), { statusCode: 503 });
    return s;
  }
  async set(id: string, session: WhipSession) {
    await this.storage().setSecret(this.key(id), JSON.stringify(session));
  }
  async terminate(id: string) {
    const s = await this.get(id);
    if (!s) return;
    try {
      const response = await fetch(`${this.srsUrl}${s.path}`, { method: 'DELETE',
        redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok && response.status !== 404) throw new Error('session termination failed');
      await this.storage().deleteSecret(this.key(id));
    } catch {
      throw Object.assign(new Error('尚未确认发布已停止，请稍后重试'), { statusCode: 503 });
    }
  }
}

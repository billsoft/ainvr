import { elapsedMs, type Lease, type LicenseClient, type TimedLease } from './licenseClient.js';
export interface GateDecision {
  block: boolean; code: 'LICENSE_REQUIRED' | 'LICENSE_SERVICE_UNAVAILABLE';
  reason?: string; status?: { state: string };
}
export interface LicenseGateOptions { enabled?: boolean; pollMs?: number; now?: () => number; retainVerifiedGrant?: boolean }
// 明确的停止信号：到期/未授权，以及时钟异常与被篡改（线上状态名 recovery_required）这类攻击信号。
// 存储故障（storage_error）可能只是磁盘卡顿，仍只降级、不清除已验证截止。
const STOP_STATES = ['expired', 'unlicensed', 'clock_error', 'recovery_required'];

export class LicenseGate {
  readonly enabled: boolean;
  private now: () => number;
  private pollMs: number;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private lease?: TimedLease;
  private licensedUntil = 0;
  private retainVerifiedGrant: boolean;
  private shortSince?: number;
  private running = false;
  private loopGeneration = 0;
  private lastDecision?: string;
  private lastError = '';
  private generation = 0;
  constructor(private client: LicenseClient, opts: LicenseGateOptions = {}) {
    // Explicit constructor injection is for isolated tests, never environment input.
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? elapsedMs;
    this.pollMs = Math.min(5000, Math.max(100, opts.pollMs ?? 5000));
    this.retainVerifiedGrant = opts.retainVerifiedGrant ?? true;
  }
  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    const loopGeneration = ++this.loopGeneration;
    const loop = async () => {
      await this.refresh();
      if (!this.running || loopGeneration !== this.loopGeneration) return;
      this.timer = setTimeout(loop, this.nextWaitMs());
      this.timer.unref?.();
    };
    void loop();
  }
  stop(): void { this.running = false; ++this.loopGeneration; if (this.timer) clearTimeout(this.timer); this.timer = undefined; ++this.generation; }
  nextWaitMs(): number {
    if (!this.lease || this.lastError) return Math.min(this.pollMs, 1000);
    try {
      const remaining = Math.max(0, this.lease.deadline - this.now());
      if (this.lease.payload.state === 'valid' && remaining < 2 * this.pollMs)
        return Math.min(this.pollMs, Math.max(100, Math.min(1000, remaining / 2)));
    } catch { return Math.min(this.pollMs, 1000); }
    return this.pollMs;
  }
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      try {
        const lease = await this.client.getLease();
        if (generation === this.generation) {
          this.lease = lease;
          if (lease.payload.state === 'valid') this.licensedUntil = lease.licensedUntil;
          else if (STOP_STATES.includes(lease.payload.state)) this.licensedUntil = 0;
          this.lastError = '';
          if (lease.payload.state === 'valid' && lease.payload.lease_ms < 10000)
            this.shortSince ??= lease.contact;
          else this.shortSince = undefined;
        }
      }
      catch (error) {
        if (generation === this.generation) this.lastError = error instanceof Error ? error.message : 'License request failed';
        // An outage never extends the verified activation deadline.
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async afterActivation(): Promise<void> {
    // Drain any pre-activation request before asking for a fresh challenge.
    if (this.pending) await this.pending;
    await this.refresh();
  }
  async afterRevocation(): Promise<void> {
    ++this.generation;
    this.lease = undefined;
    this.licensedUntil = 0;
    this.shortSince = undefined;
    if (this.pending) await this.pending;
    await this.refresh();
  }
  isExempt(url: string, method?: string): boolean {
    if (method === 'OPTIONS') return true;
    const path = url.split('?')[0] ?? '';
    if (path === '/api/settings/password' && method === 'PUT') return true;
    // Configuration polling and authenticated maintenance must remain usable.
    // Remote assistance is recovery infrastructure: licence faults are when it is needed.
    if (path === '/api/remote-assist' || path.startsWith('/api/remote-assist/')) return true;
    // System time below the trusted floor turns the licence into clock_error; correcting it must stay possible.
    if (path === '/api/system-time' || path.startsWith('/api/system-time/')) return true;
    return !path.startsWith('/api/') ||
      ['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/auth/media-session', '/api/branding'].includes(path) ||
      ['/api/license/', '/api/v1/config/', '/api/network/', '/api/observability/'].some((p) => path.startsWith(p));
  }
  decide(): GateDecision {
    if (!this.enabled) return { block: false, code: 'LICENSE_REQUIRED' };
    if (!this.lease) return { block: true, code: 'LICENSE_SERVICE_UNAVAILABLE' };
    const p = this.lease.payload;
    if (STOP_STATES.includes(p.state)) {
      try { this.observe(p.state, this.now()); } catch { /* a failed clock cannot allow business */ }
      return { block: true, code: 'LICENSE_REQUIRED', reason: p.reason, status: { state: p.state } };
    }
    try {
      const now = this.now();
      const retained = this.retainVerifiedGrant && now < this.licensedUntil;
      if ((p.state === 'valid' && now < this.lease.deadline) || retained) {
        this.observe(retained && now >= this.lease.deadline ? 'degraded' : 'valid', now);
        return { block: false, code: 'LICENSE_REQUIRED' };
      }
      this.observe('dormant', now);
    }
    catch { /* internal clock failure is not permission */ }
    return { block: true, code: 'LICENSE_SERVICE_UNAVAILABLE' };
  }
  snapshot(): Lease | undefined { return this.lease?.payload; }
  private observe(phase: string, now: number): void {
    if (this.lastDecision === phase) return;
    this.lastDecision = phase;
    const lease = this.lease;
    console.warn('[license] permission decision', JSON.stringify({ phase, wall_ms: Date.now(), internal_ms: now,
      lease_deadline_ms: lease?.deadline, licensed_until_ms: this.licensedUntil,
      contact_ms: lease?.contact, request_ms: lease?.took, short_since_ms: this.shortSince,
      retain_verified_grant: this.retainVerifiedGrant, signed_state: lease?.payload.state, lease_ms: lease?.payload.lease_ms,
      remaining_seconds: lease?.payload.remaining_seconds, last_error: this.lastError, authority: lease?.payload.diagnostics }));
  }
}

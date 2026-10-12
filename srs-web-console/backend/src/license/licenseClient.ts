import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { LicenseServiceError } from './types.js';
import type { LicenseStatus, MachineCodeInfo } from './types.js';

export interface RawResponse { status: number; body: string }
export interface LicenseTransport {
  request(method: 'GET' | 'POST', path: string, init?: { body?: string; headers?: Record<string, string>; timeoutMs?: number }): Promise<RawResponse>;
}
export interface Lease {
  v: 2; device_id: string; audience: string; nonce: string; epoch: string;
  license_id: string; grant_seq: number; revision: number; state: string;
  remaining_seconds: number; lease_ms: number; reason: string;
  authorization_ms?: number;
  diagnostics?: Record<string, unknown>;
}
export interface TimedLease { payload: Lease; deadline: number; contact: number; took: number; licensedUntil: number }
export function elapsedMs(): number {
  // Linux boottime includes suspend. /proc exposes centiseconds; consumers
  // subtract 20 ms from leases to cover sampling quantization conservatively.
  const value = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  if (!Number.isFinite(value) || value < 0) throw new Error('Internal clock unavailable');
  return value;
}
export class UdsTransport implements LicenseTransport {
  constructor(private sockPath: string, private timeoutMs = 3000) {}
  request(method: 'GET' | 'POST', path: string, init: { body?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const body = init.body ?? '';
      const headers = { Host: 'localhost', Connection: 'close', ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...init.headers };
      const conn = net.createConnection({ path: this.sockPath });
      const timer = setTimeout(() => conn.destroy(new Error('License request deadline exceeded')), init.timeoutMs ?? this.timeoutMs);
      const chunks: Buffer[] = []; let bytes = 0;
      conn.on('error', reject);
      conn.on('close', () => clearTimeout(timer));
      conn.on('connect', () => {
        conn.write(method + ' ' + path + ' HTTP/1.1\r\n' + Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('') + '\r\n' + body);
      });
      conn.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16384) { conn.destroy(new Error('License response too large')); return; }
        chunks.push(chunk);
      });
      conn.on('end', () => {
        try {
          const raw = Buffer.concat(chunks); const split = raw.indexOf('\r\n\r\n');
          if (split < 0) throw new Error('Invalid HTTP response');
          const head = raw.subarray(0, split).toString('ascii');
          const match = /^HTTP\/1\.[01] (\d{3}) /.exec(head);
          const lengths = head.split('\r\n').filter((v) => /^content-length:/i.test(v));
          const size = lengths.length === 1 ? Number(lengths[0]!.split(':')[1]?.trim()) : NaN;
          if (/^transfer-encoding:/im.test(head) || !match || !Number.isSafeInteger(size) || size !== raw.length - split - 4) throw new Error('Invalid response length');
          resolve({ status: Number(match[1]), body: raw.subarray(split + 4).toString('utf8') });
        } catch (error) { reject(error); }
      });
    });
  }
}
export interface LicenseClientOptions {
  transport?: LicenseTransport; udsPath?: string; adminApiKey?: string;
  signalKey?: string; deviceId?: string; now?: () => number; timeoutMs?: number;
}
export class LicenseClient {
  private transport: LicenseTransport;
  private adminKey: string;
  private key: Buffer;
  private device: string;
  private now: () => number;
  private inFlight?: Promise<TimedLease>;
  constructor(opts: LicenseClientOptions = {}) {
    this.transport = opts.transport ?? new UdsTransport(opts.udsPath ?? process.env.LICENSE_UDS_PATH ?? '/run/ainvr-license/license.sock', opts.timeoutMs);
    this.adminKey = opts.adminApiKey ?? process.env.LICENSE_ADMIN_API_KEY ?? '';
    const hex = opts.signalKey ?? process.env.LICENSE_SIGNAL_KEY ?? '';
    this.key = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    this.device = (opts.deviceId ?? process.env.LICENSE_DEVICE_ID ?? '').replace(/[\s-]/g, '').toUpperCase();
    this.now = opts.now ?? elapsedMs;
  }
  async getMachineCode(): Promise<MachineCodeInfo> { return JSON.parse((await this.call('GET', '/api/v1/license/machine-code')).body); }
  async getStatus(_force = false): Promise<LicenseStatus> {
    const result = JSON.parse((await this.call('GET', '/api/v1/license/status')).body);
    if (!result || typeof result.state !== 'string' || typeof result.remaining_seconds !== 'number' || typeof result.seq !== 'number') throw new LicenseServiceError('LICENSE_SERVICE_UNAVAILABLE', '授权状态格式错误');
    return result;
  }
  async preview(key: string): Promise<unknown> { return JSON.parse((await this.call('POST', '/api/v1/license/preview', JSON.stringify({ key }), { 'X-API-Key': this.adminKey })).body); }
  async activate(key: string): Promise<LicenseStatus> { return JSON.parse((await this.call('POST', '/api/v1/license/activate', JSON.stringify({ key }), { 'X-API-Key': this.adminKey })).body); }
  invalidateCache(): void { /* Status is never used as a cached permission. */ }
  async remove(confirmation: string): Promise<LicenseStatus> { return JSON.parse((await this.call('POST', '/api/v1/license/remove', JSON.stringify({ confirmation }), { 'X-API-Key': this.adminKey })).body); }
  getLease(): Promise<TimedLease> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchLease().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async fetchLease(): Promise<TimedLease> {
    if (this.key.length !== 32 || !/^[0-9A-HJKMNP-TV-Z]{24}$/.test(this.device)) throw new LicenseServiceError('LICENSE_CONFIGURATION_ERROR', '授权消费者凭据未配置');
    const start = this.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const response = await this.call('GET', '/api/v1/license/signed-status?client_id=console-backend&nonce=' + nonce);
    const envelope = JSON.parse(response.body);
    if (typeof envelope.payload !== 'string' || envelope.payload.length > 12000 || !/^[A-Za-z0-9_-]+$/.test(envelope.payload) || !/^[0-9a-f]{64}$/.test(envelope.sig)) throw new Error('Invalid lease envelope');
    const expected = crypto.createHmac('sha256', this.key).update('AINVR/lease/v2|' + envelope.payload).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(envelope.sig, 'hex'))) throw new Error('Invalid lease signature');
    const p = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8')) as Lease;
    if (p.v !== 2 || p.device_id !== this.device || p.audience !== 'console-backend' || p.nonce !== nonce || typeof p.epoch !== 'string' || p.epoch.length !== 32) throw new Error('Lease binding mismatch');
    if (!['valid', 'unlicensed', 'expired', 'storage_error', 'clock_error', 'recovery_required'].includes(p.state)) throw new Error('Invalid license state');
    for (const [value, max] of [[p.lease_ms, 30000], [p.remaining_seconds, 315360000], [p.revision, Number.MAX_SAFE_INTEGER], [p.grant_seq, Number.MAX_SAFE_INTEGER]]) {
      if (!Number.isSafeInteger(value) || value! < 0 || value! > max!) throw new Error('Invalid lease number');
    }
    if (typeof p.license_id !== 'string' || ![0, 32].includes(p.license_id.length) || (['valid', 'expired'].includes(p.state) && !/^[0-9a-f]{32}$/.test(p.license_id))) throw new Error('Invalid license identity');
    if (p.lease_ms > p.remaining_seconds * 1000 || (p.state !== 'valid' && p.lease_ms !== 0)) throw new Error('Invalid lease duration');
    const contact = this.now();
    if (p.authorization_ms !== undefined && (!Number.isSafeInteger(p.authorization_ms) ||
      p.authorization_ms < 0 || p.authorization_ms > p.remaining_seconds * 1000)) throw new Error('Invalid authorization duration');
    return { payload: p, deadline: start + Math.max(0, p.lease_ms - 20), contact,
      took: Math.max(0, contact - start), licensedUntil: start + (p.authorization_ms ?? Math.max(0, p.remaining_seconds - 1) * 1000) };
  }
  private async call(method: 'GET' | 'POST', path: string, body?: string, headers: Record<string, string> = {}): Promise<RawResponse> {
    let r: RawResponse;
    try { r = await this.transport.request(method, path, { body, headers }); }
    catch (error) { throw new LicenseServiceError('LICENSE_SERVICE_UNAVAILABLE', (error as Error).message); }
    if (r.status >= 200 && r.status < 300) return r;
    if (r.status === 401) throw new LicenseServiceError('LICENSE_CONFIGURATION_ERROR', '授权服务管理凭据不匹配，请检查部署', 503);
    let data: { code?: string; message?: string } = {};
    try { data = JSON.parse(r.body); } catch { /* bounded upstream body */ }
    throw new LicenseServiceError(data.code ?? 'LICENSE_SERVICE_UNAVAILABLE', data.message ?? '授权服务请求失败', r.status);
  }
}

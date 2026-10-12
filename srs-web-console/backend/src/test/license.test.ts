import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { LicenseClient, type LicenseTransport, type Lease } from '../license/licenseClient.js';
import { LicenseGate } from '../license/licenseGate.js';
import { licenseRoutes } from '../routes/license.js';
const device = '0123456789ABCDEFGHJKMNPQ';
const key = '00'.repeat(32);

function transport(change: Partial<Lease> = {}): LicenseTransport {
  return { async request(_method, path) {
    const nonce = new URL('http://local' + path).searchParams.get('nonce');
    const p = { v: 2, device_id: device, audience: 'console-backend', nonce,
      epoch: 'a'.repeat(32), license_id: 'b'.repeat(32), grant_seq: 1, revision: 1,
      state: 'valid', remaining_seconds: 60, lease_ms: 30000, reason: '', ...change };
    const payload = Buffer.from(JSON.stringify(p)).toString('base64url');
    const sig = crypto.createHmac('sha256', Buffer.from(key, 'hex')).update('AINVR/lease/v2|' + payload).digest('hex');
    return { status: 200, body: JSON.stringify({ payload, sig }) };
  } };
}
describe('V2 leases', () => {
  it('does not shorten or extend the verified activation on transport/storage failure', async () => {
    let now = 1000; let mode = 'valid';
    const t: LicenseTransport = { async request(method, path) {
      if (mode === 'offline') throw new Error('offline');
      return transport(mode === 'valid' ? { authorization_ms: 60000 } : { state: 'storage_error', lease_ms: 0 }).request(method, path);
    } };
    const gate = new LicenseGate(new LicenseClient({ transport: t, deviceId: device, signalKey: key, now: () => now }), { now: () => now });
    await gate.refresh(); mode = 'offline'; now = 40000; await gate.refresh();
    expect(gate.decide().block).toBe(false);
    mode = 'storage'; now = 60000; await gate.refresh();
    expect(gate.decide().block).toBe(false);
    now = 61000; expect(gate.decide().block).toBe(true);
  });
  it('renews short leases without exceeding signed activation time', async () => {
    let now = 1000;
    const client = new LicenseClient({ transport: transport({ lease_ms: 0, remaining_seconds: 5 }), deviceId: device, signalKey: key, now: () => now });
    const gate = new LicenseGate(client, { now: () => now });
    await gate.refresh();
    expect(gate.decide().block).toBe(false);
    expect(gate.nextWaitMs()).toBe(100);
    now += 4000;
    expect(gate.decide().block).toBe(true);
  });
  it('retains activation through an outage but honors revocation', async () => {
    let now = 1000;
    const client = new LicenseClient({ transport: transport({ lease_ms: 0 }), deviceId: device, signalKey: key, now: () => now });
    const gate = new LicenseGate(client, { now: () => now });
    await gate.refresh();now += 15001;
    expect(gate.decide().block).toBe(false);
    const expired = new LicenseGate(new LicenseClient({ transport: transport({ state: 'expired', lease_ms: 0 }), deviceId: device, signalKey: key, now: () => now }), { now: () => now });
    await expired.refresh();expect(expired.decide().block).toBe(true);
  });
  it('clock_error and recovery_required clear the verified deadline at once', async () => {
    for (const state of ['clock_error', 'recovery_required']) {
      let now = 1000;
      let current = 'valid';
      const client = new LicenseClient({ transport: { request: async (method, path) => transport({ state: current, lease_ms: current === 'valid' ? 30000 : 0, remaining_seconds: 3600 }).request(method, path) }, deviceId: device, signalKey: key, now: () => now });
      const gate = new LicenseGate(client, { now: () => now });
      await gate.refresh();
      expect(gate.decide().block).toBe(false);
      current = state; now += 5;
      await gate.refresh();
      expect(gate.decide().block).toBe(true);
    }
  });
  it('startup offline never allows business', async () => {
    let now = 1000;
    const client = new LicenseClient({ transport: { request: async () => { throw new Error('offline'); } }, deviceId: device, signalKey: key, now: () => now });
    const gate = new LicenseGate(client, { enabled: true, now: () => now });
    await gate.refresh(); now += 86400000;
    expect(gate.decide().block).toBe(true);
    expect(gate.isExempt('/api/license/activate')).toBe(true);
    expect(gate.isExempt('/api/auth/login')).toBe(true);
    expect(gate.isExempt('/api/v1/config/poll')).toBe(true);
    // 授权故障时恰恰需要远程协助排查，不能被业务闸门挡住
    expect(gate.isExempt('/api/remote-assist', 'GET')).toBe(true);
    expect(gate.isExempt('/api/remote-assist/enable', 'POST')).toBe(true);
    expect(gate.isExempt('/api/remote-assistant', 'GET')).toBe(false);
    // 系统时间无效时授权会报时钟错误：校时接口被挡住就成了死锁
    expect(gate.isExempt('/api/system-time', 'GET')).toBe(true);
    expect(gate.isExempt('/api/system-time', 'PUT')).toBe(true);
    expect(gate.isExempt('/api/system-time/ntp-servers', 'PUT')).toBe(true);
    expect(gate.isExempt('/api/system-timer', 'GET')).toBe(false);
  });
  it('valid leases stop at the original internal deadline', async () => {
    let now = 1000;
    const client = new LicenseClient({ transport: transport(), deviceId: device, signalKey: key, now: () => now });
    const gate = new LicenseGate(client, { enabled: true, now: () => now });
    await gate.refresh();
    expect(gate.decide().block).toBe(false);
    now += 59000;
    expect(gate.decide().block).toBe(true);
  });
  it.each([
    { audience: 'recorder' }, { device_id: 'X'.repeat(24) }, { nonce: 'old' },
    { lease_ms: 30001 }, { lease_ms: -1 }, { remaining_seconds: 1 },
    { state: 'expired', lease_ms: 1000 }, { revision: 1.5 },
  ])('rejects invalid contract %j', async (change) => {
    const client = new LicenseClient({ transport: transport(change), deviceId: device, signalKey: key, now: () => 1 });
    await expect(client.getLease()).rejects.toThrow();
  });
  it('upstream management credential failure does not become user logout', async () => {
    const app = Fastify();
    const client = new LicenseClient({ transport: { request: async () => ({ status: 401, body: '{"code":"UNAUTHORIZED"}' }) } });
    await app.register(licenseRoutes, { client });
    const result = await app.inject({ method: 'POST', url: '/license/activate', payload: { key: 'AINVR-LIC-example' } });
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('LICENSE_CONFIGURATION_ERROR');
    await app.close();
  });
  it('configuration failure never supplies a lease', async () => {
    const client = new LicenseClient({ transport: transport(), signalKey: '', deviceId: device });
    await expect(client.getLease()).rejects.toThrow();
  });
});

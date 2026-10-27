import { it, expect, vi } from 'vitest';
import { preparePtzAdapter, ONVIF_IDENTITY_QUERY } from '../services/ptzAdapter.js';
import type { Channel } from '../types/channel.js';
import type { OnvifManager } from '../services/onvifManager.js';
import type { PtzStore } from '../store/ptzStore.js';
it('accepts the real protocol representation of a fixed camera without inventing controls', async () => {
  const preparePtz = vi.fn(async () => ({
    capabilities: {
      resource: '',
      panTilt: false,
      zoom: false,
      presets: false,
      presetWrite: false,
      position: false,
      moveStatus: false,
      relativePanTilt: false,
      relativeZoom: false,
      continuousPanTilt: false,
      continuousZoom: false,
      reason: 'ptz_not_supported',
    },
  }));
  const adapter = await preparePtzAdapter(
    { id: 'fixed', onvif: { deviceId: 'device' } } as Channel,
    {} as PtzStore,
    { preparePtz } as unknown as OnvifManager,
    null,
  );
  expect(adapter?.caps.reason).toBe('ptz_not_supported');
  expect(adapter?.caps.panTilt).toBe(false);
  expect(adapter?.caps.zoom).toBe(false);
  await expect(adapter?.call('command')).rejects.toMatchObject({ code: 'ptz_not_supported' });
});

it('refuses known duplicate device identities before movement instead of merging serial numbers', async () => {
  const query = vi.fn(async () => ({ rows: [{ version: 1, identity_conflict: true }] }));
  const ptz = vi.fn();
  const adapter = await preparePtzAdapter(
    { id: 'camera', onvif: { deviceId: 'device', deviceVersion: 1 } } as Channel,
    { pool: { query } } as unknown as PtzStore,
    { preparePtz: async () => ({
      context: 'a'.repeat(48), serverTimeMs: Date.now(),
      capabilities: { resource: 'motor', panTilt: true, zoom: true, presets: true,
        presetWrite: true, position: true, moveStatus: true, relativePanTilt: false,
        relativeZoom: false, continuousPanTilt: true, continuousZoom: true },
    }), ptz, store: { settings: async () => ({ settings: { enabled: true } }) } } as unknown as OnvifManager,
    null,
  );
  await expect(adapter?.verify?.()).rejects.toMatchObject({ code: 'ptz_device_identity_conflict' });
  expect(ptz).not.toHaveBeenCalled();
});

// Isolated temporary table; never connects to the production database.
import { Pool } from 'pg';
it.skipIf(process.env.AINVR_PTZ_TEST_PG !== '1')('compares absent hardware IDs and whitespace in real PostgreSQL', async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 25439, user: 'alarm_test', database: 'alarm_test' });
  const client = await pool.connect();
  try {
    await client.query('CREATE TEMP TABLE onvif_devices(device_id text, version integer, epr text, capabilities jsonb)');
    await client.query('INSERT INTO onvif_devices VALUES ($1,1,NULL,$2),($3,1,NULL,$4)',
      ['one', JSON.stringify({ manufacturer: 'Vendor ', serial: ' 123' }), 'two', JSON.stringify({ manufacturer: ' Vendor', serial: '123 ' })]);
    expect((await client.query(ONVIF_IDENTITY_QUERY, ['one'])).rows[0].identity_conflict).toBe(true);
    await client.query("UPDATE onvif_devices SET capabilities=capabilities || '{\"hardwareID\":\"different\"}'::jsonb WHERE device_id='two'");
    expect((await client.query(ONVIF_IDENTITY_QUERY, ['one'])).rows[0].identity_conflict).toBe(false);
    await client.query("UPDATE onvif_devices SET capabilities=capabilities || '{\"hardwareID\":\"  \"}'::jsonb WHERE device_id='two'");
    expect((await client.query(ONVIF_IDENTITY_QUERY, ['one'])).rows[0].identity_conflict).toBe(true);
  } finally { client.release(); await pool.end(); }
});

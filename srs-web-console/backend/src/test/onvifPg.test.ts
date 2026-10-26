import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgConfigStore } from '../store/pgStore.js';
import { OnvifStore, defaultOnvifSettings } from '../store/onvifStore.js';
import { JsonStore } from '../store/jsonStore.js';
import { ChannelService } from '../services/channelService.js';
import { DEFAULT_SETTINGS } from '../types/channel.js';

const configPath = process.env.AINVR_ONVIF_TEST_PG_CONFIG;
describe.skipIf(!configPath)('ONVIF isolated PostgreSQL', () => {
  it('persists encrypted device settings, rejects stale edits and keeps channel/source identity across restart', async () => {
    const config = JSON.parse(await readFile(configPath!, 'utf8'));
    if (config.port !== 25432 || config.database !== 'onvif_test')
      throw Error('Refusing non-test PostgreSQL');
    const temp = await mkdtemp(join(tmpdir(), 'ainvr-onvif-pg-'));
    const pg = new PgConfigStore({ poolConfig: config, masterKeyPath: join(temp, 'master.key') });
    try {
      await pg.init();
      const store = new OnvifStore(pg);
      const current = await store.settings();
      await store.saveSettings(
        { ...defaultOnvifSettings, allowedCIDRs: ['192.0.2.0/24'] },
        current.revision,
        'k'.repeat(32),
        'test',
      );
      const first = await store.saveDevice(
        {
          name: 'NVR',
          url: 'http://192.0.2.10/device',
          username: 'operator',
          password: 'private-test-password',
          certificateSHA256: '',
          epr: 'urn:uuid:' + randomUUID(),
        },
        'test',
      );
      const listed = await store.devices();
      expect(JSON.stringify(listed)).not.toContain('private-test-password');
      expect(listed.find((d) => d.id === first.id)?.name).toBe('NVR');
      const row = (
        await pg.pool.query('SELECT ciphertext FROM config_secrets WHERE key_path=$1', [
          `onvif/device/${first.id}`,
        ])
      ).rows[0];
      expect(row.ciphertext.toString()).not.toContain('private-test-password');
      expect((await store.device(first.id)).device.password).toBe('private-test-password');
      const edits = await Promise.allSettled(
        ['Name A', 'Name B'].map((name) =>
          store.saveDevice(
            {
              id: first.id,
              expectedVersion: 1,
              name,
              url: 'http://192.0.2.10/device',
              username: 'operator',
              certificateSHA256: '',
            },
            'test',
          ),
        ),
      );
      expect(edits.filter((e) => e.status === 'fulfilled')).toHaveLength(1);
      expect(edits.filter((e) => e.status === 'rejected')).toHaveLength(1);
      const channels = new JsonStore<any>({
        filePath: join(temp, 'channels.json'),
        defaultData: { channels: [] },
        version: 1,
      });
      const settings = new JsonStore<any>({
        filePath: join(temp, 'settings.json'),
        defaultData: DEFAULT_SETTINGS,
        version: 1,
      });
      const service = new ChannelService({
        store: channels,
        settingsStore: settings,
        secrets: () => pg,
        srsClient: { listStreams: async () => [], isOnline: async () => true } as any,
      });
      const onvif = {
        deviceId: first.id,
        deviceVersion: 2,
        service: 'media2' as const,
        profileToken: 'main',
        videoSource: 'source-a',
      };
      const input = {
        name: 'Camera',
        upstreamProtocol: 'rtsp' as const,
        downstreamProtocols: ['flv' as const],
        rtspUrl: 'rtsp://192.0.2.10/live?opaque=private-uri-token',
        inputUsername: 'operator',
        inputPassword: 'private-test-password',
        onvif,
        inputAudioMode: 'auto' as const,
      };
      const created = await service.createChannel(input);
      expect(created.onvif).toEqual(onvif);
      expect(created).not.toHaveProperty('rtspUrl');
      expect(created).not.toHaveProperty('sourceRef');
      const raw = await readFile(join(temp, 'channels.json'), 'utf8');
      expect(raw).not.toContain('private-uri-token');
      expect(raw).not.toContain('private-test-password');
      await service.updateChannel(created.id, { inputEnabled: false });
      await service.updateChannel(created.id, { inputEnabled: true });
      const privateInput = (await channels.read()).channels[0];
      const uri = await pg.getSecret(privateInput.sourceRef);
      expect(uri).toContain('opaque=private-uri-token');
      await expect(
        service.createChannel({ ...input, streamName: 'another' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const restarted = new OnvifStore(pg);
      expect((await restarted.device(first.id)).record.version).toBe(2);
      expect((await service.getChannel(created.id))?.onvif?.videoSource).toBe('source-a');
    } finally {
      await pg.pool.end();
      await rm(temp, { recursive: true, force: true });
    }
  }, 30000);
});

import { beforeEach, expect, it, vi } from 'vitest';
const fs = vi.hoisted(() => ({ open: vi.fn(), mkdir: vi.fn(), stat: vi.fn(), realpath: vi.fn(), opendir: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), ...fs }));
import { FacesPhotos } from '../services/facesPhotos.js';
const volume = { id: 'ssd-uuid', device: '/dev/nvme0n1p1', filesystem: 'ext4', mountPath: '/mnt/ainvr-ssd', system: false, readOnly: false, selectable: true, state: 'mounted' };
beforeEach(() => {
  vi.resetAllMocks();
  fs.realpath.mockImplementation(async (path: string) => path);
  fs.stat.mockImplementation(async (path: string) => path === '/' ? { dev: 1 } : { rdev: 2, isBlockDevice: () => true });
  fs.open.mockImplementation(async (path: string) => {
    if (path === '/mnt/ainvr-ssd') return { fd: 10, stat: async () => ({ dev: 2 }), close: vi.fn() };
    if (path === '/proc/self/fd/11/ainvr-faces') return { fd: 12, stat: async () => ({ dev: 2 }), close: vi.fn() };
    throw Error('Unexpected path');
  });
  fs.mkdir.mockResolvedValue(undefined);
  fs.opendir.mockImplementation(async () => (async function* () {})());
});
it('accepts the existing volume contract and opens only its private SSD namespace', async () => {
  fs.open.mockImplementation(async (path: string) => {
    if (path === '/mnt/ainvr-ssd') return { fd: 10, stat: async () => ({ dev: 2 }), close: vi.fn() };
    if (path === '/proc/self/fd/10/ainvr-faces') return { fd: 12, stat: async () => ({ dev: 2 }), close: vi.fn() };
    throw Error('Unexpected path');
  });
  const volumes = vi.fn(async () => ({ volumes: [{ ...volume, id: 'system', mountPath: '/', system: true, selectable: false, state: 'system' }, volume] }));
  await new FacesPhotos(volumes).cleanup(new Set());
  expect(volumes).toHaveBeenCalledOnce();
  expect(fs.mkdir).toHaveBeenCalledExactlyOnceWith('/proc/self/fd/10/ainvr-faces', { mode: 0o700 });
});
it('reports EACCES creating an unprovisioned namespace, without selecting another location', async () => {
  fs.mkdir.mockRejectedValue(Object.assign(Error('permission denied'), { code: 'EACCES' }));
  await expect(new FacesPhotos(async () => ({ volumes: [volume] })).cleanup(new Set())).rejects.toMatchObject({ code: 'faces_storage_unavailable' });
  expect(fs.mkdir).toHaveBeenCalledExactlyOnceWith('/proc/self/fd/10/ainvr-faces', { mode: 0o700 });
});
it('rejects readonly volumes and wrong-device mounts before creating files', async () => {
  await expect(new FacesPhotos(async () => ({ volumes: [{ ...volume, readOnly: true }] })).cleanup(new Set())).rejects.toMatchObject({ code: 'faces_storage_unavailable' });
  fs.stat.mockImplementation(async (path: string) => path === '/' ? { dev: 1 } : { rdev: 3, isBlockDevice: () => true });
  await expect(new FacesPhotos(async () => ({ volumes: [volume] })).cleanup(new Set())).rejects.toMatchObject({ code: 'faces_storage_unavailable' });
  expect(fs.mkdir).not.toHaveBeenCalled();
});

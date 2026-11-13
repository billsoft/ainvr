import { it, expect } from 'vitest';
import { mkdtemp, writeFile, link, stat, utimes, readdir, unlink, rmdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverFacesTemporaryLinks } from '../services/facesPhotos.js';
it('recovers a crash after immutable link without deleting the final photo or fresh tmp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'faces-link-test-'));
  const temporary = join(dir, `.${randomUUID()}.tmp`), final = join(dir, `${randomUUID()}.jpg`), fresh = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, 'immutable'); await link(temporary, final); await writeFile(fresh, 'pending');
    const old = new Date(Date.now() - 301000); await utimes(temporary, old, old);
    expect((await stat(final)).nlink).toBe(2);
    const directory = await open(dir, 'r');
    try { expect(await recoverFacesTemporaryLinks(`/proc/self/fd/${directory.fd}`)).toBe(1); } finally { await directory.close(); }
    expect((await stat(final)).nlink).toBe(1);
    expect((await stat(fresh)).nlink).toBe(1);
    expect(await recoverFacesTemporaryLinks(dir)).toBe(0);
  } finally { for (const name of await readdir(dir)) await unlink(join(dir, name)); await rmdir(dir); }
});

import { constants } from 'node:fs';
import { open, mkdir, link, unlink, stat, lstat, opendir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { selectedFloorPlanDirectory } from './floorPlanImages.js';
import { FacesError, facesId } from './facesContract.js';

export interface FacesPhotoRef { ref: string; generation: string; sha256: string; bytes: number }
const unavailable = () => new FacesError('faces_storage_unavailable', '人脸照片存储不可用；必须使用已选SSD，不回退系统盘', 503);
/** Recover only our expired temporary directory entries, never the final link.
 * The caller holds the Mongo writer lease; 5 minutes exceeds its 120s lifetime.
 */
export async function recoverFacesTemporaryLinks(dir: string, now = Date.now()) {
  let scanned = 0, removed = 0;
  for await (const entry of await opendir(dir)) {
    if (++scanned > 8192 || removed >= 32) break;
    if (!/^\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.name)) continue;
    const file = await open(`${dir}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(), current = await lstat(`${dir}/${entry.name}`);
      if (!info.isFile() || info.nlink < 1 || info.nlink > 2 || info.mtimeMs > now - 300000 || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()) continue;
      await unlink(`${dir}/${entry.name}`); removed++;
    } finally { await file.close(); }
  }
  if (removed) { const directory = await open(`${dir}/.`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await directory.sync(); } finally { await directory.close(); } }
  return removed;
}
export class FacesPhotos {
  constructor(private readonly volumes: () => Promise<unknown>) {}
  private async directory<T>(action: (path: string, generation: string) => Promise<T>, generation?: string): Promise<T> {
    const selected = selectedFloorPlanDirectory(await this.volumes(), generation);
    if (!selected) throw unavailable();
    let mount: Awaited<ReturnType<typeof open>> | undefined, directory: Awaited<ReturnType<typeof open>> | undefined;
    try {
      mount = await open(selected.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const mounted = await mount.stat(), system = await stat('/'), device = await stat(selected.device);
      if (mounted.dev === system.dev || !device.isBlockDevice() || device.rdev !== mounted.dev) throw unavailable();
      const root = `/proc/self/fd/${mount.fd}/ainvr-faces`;
      await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if ((await directory.stat()).dev !== mounted.dev) throw unavailable();
      return await action(`/proc/self/fd/${directory.fd}`, selected.generation);
    } catch (error) { if (error instanceof FacesError) throw error; throw unavailable(); }
    finally { await directory?.close(); await mount?.close(); }
  }
  async publish(ref: string, bytes: Buffer): Promise<FacesPhotoRef> {
    facesId.parse(ref); const sha256 = createHash('sha256').update(bytes).digest('hex');
    return this.directory(async (dir, generation) => {
      await recoverFacesTemporaryLinks(dir);
      let count = 0, total = 0;
      for await (const entry of await opendir(dir)) {
        if (!/^(?:[a-f0-9-]{36}\.jpg|\.[a-f0-9-]{36}\.tmp)$/.test(entry.name)) throw unavailable();
        if (++count > 4096) throw new FacesError('faces_photo_capacity', '人脸照片数量已达存储上限', 429);
        const info = await lstat(`${dir}/${entry.name}`);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw unavailable();
        total += info.size;
      }
      const final = `${dir}/${ref}.jpg`;
      try {
        const file = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const stored = await file.readFile(); if (stored.length !== bytes.length || createHash('sha256').update(stored).digest('hex') !== sha256) throw new FacesError('idempotency_conflict', '图片引用已用于其他内容', 409); }
        finally { await file.close(); }
        return { ref, generation, sha256, bytes: bytes.length };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (count >= 4096 || total + bytes.length > 512 * 1024 * 1024) throw new FacesError('faces_photo_capacity', '人脸照片存储配额已满，未删除有效证据', 429);
      const temporary = `${dir}/.${randomUUID()}.tmp`;
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        await link(temporary, final);
      } finally { await unlink(temporary).catch(() => undefined); }
      const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); }
      return { ref, generation, sha256, bytes: bytes.length };
    });
  }
  async read(photo: FacesPhotoRef): Promise<Buffer> {
    facesId.parse(photo.ref);
    return this.directory(async dir => {
      const file = await open(`${dir}/${photo.ref}.jpg`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size !== photo.bytes || info.size > 4 * 1024 * 1024) throw unavailable();
        const bytes = await file.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== photo.sha256) throw unavailable();
        return bytes;
      } finally { await file.close(); }
    }, photo.generation);
  }
  async remove(photo: FacesPhotoRef) {
    facesId.parse(photo.ref);
    return this.directory(async dir => { await unlink(`${dir}/${photo.ref}.jpg`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }, photo.generation);
  }
  /** Only this namespace, only unreferenced files older than a writer lease. */
  async cleanup(retained: Set<string>) {
    return this.directory(async dir => {
      await recoverFacesTemporaryLinks(dir);
      let scanned = 0, removed = 0;
      for await (const entry of await opendir(dir)) {
        if (++scanned > 8192 || removed >= 32) break;
        const jpeg = /^([a-f0-9-]{36})\.jpg$/.exec(entry.name), temporary = /^\.[a-f0-9-]{36}\.tmp$/.test(entry.name);
        if ((!jpeg && !temporary) || (jpeg && retained.has(jpeg[1]))) continue;
        const info = await lstat(`${dir}/${entry.name}`);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mtimeMs > Date.now() - 300000) continue;
        await unlink(`${dir}/${entry.name}`); removed++;
      }
      if (removed) { const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
    });
  }
}

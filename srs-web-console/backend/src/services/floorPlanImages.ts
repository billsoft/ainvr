import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, unlink, rename, opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AlarmConfigError } from '../store/alarmZones.js';

export interface ImageRef { ref: string; w: number; h: number; sha256: string; generation: string }
export const invalidImage = () => new AlarmConfigError('invalid_image', '底图须先在浏览器解码并转为 JPEG；上传结构或尺寸无效');
const unavailable = () => new AlarmConfigError('storage_unavailable', '底图存储不可用，请检查选定磁盘及目录权限', 503);

// Structural validation only: pixels are never decoded here. The UI must
// successfully decode and normalize a source image before sending its JPEG.
export function parseFloorPlanJpeg(data: string, w: number, h: number): Buffer {
  const prefix = 'data:image/jpeg;base64,';
  if (!data.startsWith(prefix) || data.length > 2500000) throw invalidImage();
  const encoded = data.slice(prefix.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalidImage();
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 16 || bytes.length > 1875000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
    bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9) throw invalidImage();
  let i=2, width=0, height=0, progressive=false, sawScan=false, sawEnd=false, restartInterval=0;
  const quant=new Set<number>(), huffman=new Set<string>();
  const components=new Map<number,{quant:number;precision:number[]}>();
  while (i < bytes.length) {
    if (bytes[i++] !== 0xff) throw invalidImage();
    while (bytes[i] === 0xff) i++;
    const marker=bytes[i++];
    if (marker === 0xd9) { sawEnd=i === bytes.length; break; }
    if (marker === undefined || i+2 > bytes.length) throw invalidImage();
    const length=bytes.readUInt16BE(i), end=i+length;
    if (length < 2 || end > bytes.length) throw invalidImage();
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (width || length < 11 || bytes[i+2] !== 8) throw invalidImage();
      height=bytes.readUInt16BE(i+3); width=bytes.readUInt16BE(i+5);
      progressive=marker === 0xc2;
      const count=bytes[i+7]!;
      if (count < 1 || count > 4 || length !== 8+3*count) throw invalidImage();
      let sampling=0;
      for (let p=i+8;p<end;p+=3) {
        const id=bytes[p]!, sample=bytes[p+1]!, q=bytes[p+2]!, h=sample>>4, v=sample&15;
        if (components.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || q > 3) throw invalidImage();
        sampling+=h*v; components.set(id,{quant:q,precision:Array(64).fill(-1)});
      }
      if (sampling > 10) throw invalidImage();
    } else if (marker === 0xdb) {
      let p=i+2;
      if (p === end) throw invalidImage();
      while (p < end) {
        const table=bytes[p++]!, precision=table>>4, id=table&15, size=precision ? 2 : 1;
        if (precision > 1 || id > 3 || p+64*size > end) throw invalidImage();
        for (let n=0;n<64;n++,p+=size)
          if ((size === 1 ? bytes[p]! : bytes.readUInt16BE(p)) === 0) throw invalidImage();
        quant.add(id);
      }
    } else if (marker === 0xc4) {
      let p=i+2;
      if (p === end) throw invalidImage();
      while (p < end) {
        const table=bytes[p++]!, kind=table>>4, id=table&15;
        if (kind > 1 || id > 3 || p+16 > end) throw invalidImage();
        let count=0, available=1;
        for (let n=0;n<16;n++) { const codes=bytes[p++]!; count+=codes; available=available*2-codes; if (available < 0) throw invalidImage(); }
        if (!count || count > 256 || !available || p+count > end) throw invalidImage();
        for (let n=0;n<count;n++) {
          const symbol=bytes[p+n]!;
          if (kind === 0 && symbol > 11 || kind === 1 && (symbol&15) > 10) throw invalidImage();
        }
        p+=count; huffman.add(kind+':'+id);
      }
    } else if (marker === 0xdd) {
      if (length !== 4) throw invalidImage();
      restartInterval=bytes.readUInt16BE(i+2);
    } else if (marker === 0xda) {
      const count=bytes[i+2]!;
      if (!width || count < 1 || count > components.size || length !== 6+2*count) throw invalidImage();
      const first=bytes[end-3]!, last=bytes[end-2]!, successive=bytes[end-1]!, high=successive>>4, low=successive&15;
      if (!progressive && (first !== 0 || last !== 63 || successive !== 0) ||
        progressive && (first > last || last > 63 || first === 0 && last !== 0 || first > 0 && count !== 1 ||
          high > 13 || low > 13 || high !== 0 && high !== low+1)) throw invalidImage();
      const scan=new Set<number>();
      for (let p=i+3;p<end-3;p+=2) {
        const id=bytes[p]!, tables=bytes[p+1]!, dc=tables>>4, ac=tables&15, component=components.get(id);
        if (!component || scan.has(id) || dc > 3 || ac > 3 || !quant.has(component.quant)) throw invalidImage();
        if ((!progressive || first === 0 && high === 0) && !huffman.has('0:'+dc) ||
          (!progressive || first > 0) && !huffman.has('1:'+ac) ||
          progressive && (first === 0 && ac !== 0 || first > 0 && dc !== 0)) throw invalidImage();
        for (let coefficient=first;coefficient<=last;coefficient++) {
          const previous=component.precision[coefficient]!;
          if (high === 0 ? previous !== -1 : previous !== high) throw invalidImage();
          component.precision[coefficient]=low;
        }
        scan.add(id);
      }
      sawScan=true;
      i=end;
      let entropy=0, found=false, nextRestart=0;
      while (i < bytes.length-1) {
        if (bytes[i] !== 0xff) { entropy++; i++; continue; }
        const markerStart=i++;
        while (bytes[i] === 0xff) i++;
        const next=bytes[i];
        if (next === 0) { entropy++; i++; continue; }
        if (next !== undefined && next >= 0xd0 && next <= 0xd7) {
          if (!restartInterval || next !== 0xd0+nextRestart) throw invalidImage();
          nextRestart=(nextRestart+1)%8; i++; continue;
        }
        i=markerStart; found=true; break;
      }
      if (!found || !entropy) throw invalidImage();
      continue;
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) throw invalidImage();
    i=end;
  }
  if (!sawScan || !sawEnd || [...components.values()].some(c=>c.precision[0] === -1) ||
    width !== w || height !== h || width < 1 || height < 1 || width > 1600 || height > 1600 ||
    width*height > 2560000) throw invalidImage();
  return bytes;
}

type Directory = { root: string; generation: string; device:string };
export function selectedFloorPlanDirectory(volumes: unknown, expectedGeneration?: string): Directory | null {
  const parsed = z.object({ volumes: z.array(z.object({
    id:z.string().min(1), device:z.string().min(1), filesystem:z.string().min(1),
    mountPath:z.string(), system:z.boolean(), readOnly:z.boolean(),
    selectable:z.boolean(), state:z.string(),
  }).passthrough()).max(256) }).safeParse(volumes);
  if (!parsed.success) return null;
  const candidates = parsed.data.volumes.filter(v => v.selectable && !v.system && !v.readOnly &&
    v.state === 'mounted' && /^\/(?:mnt|media|run\/media)\//.test(v.mountPath) &&
    !/[\u0000-\u001f\u007f]/.test(v.mountPath) &&
    parsed.data.volumes.filter(other => other.id === v.id).length === 1)
    .map(v => ({ root:path.posix.resolve(v.mountPath), device:v.device,
      generation:createHash('sha256').update(JSON.stringify([v.id,v.device,v.filesystem,path.posix.resolve(v.mountPath)])).digest('hex') }));
  const matches = expectedGeneration ? candidates.filter(v => v.generation === expectedGeneration) : candidates;
  return matches.length === 1 ? matches[0]! : null;
}

// Work relative to an open mount fd. If unmounted after validation, operations
// cannot fall through to a directory on the system disk.
export class FloorPlanImages {
  constructor(private readonly directory: (generation?:string) => Promise<Directory | null>) {}
  private async withDirectory<T>(fn: (dir: string, generation: string) => Promise<T>, expectedGeneration?:string): Promise<T> {
    let rootHandle: Awaited<ReturnType<typeof open>> | undefined;
    let dirHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const selected = await this.directory(expectedGeneration);
      if (!selected) throw unavailable();
      rootHandle = await open(selected.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await rootHandle.stat(), system = await (await import('node:fs/promises')).stat('/');
      if (stat.dev === system.dev) throw unavailable();
      const device = await (await import('node:fs/promises')).stat(selected.device);
      if (!device.isBlockDevice() || device.rdev !== stat.dev) throw unavailable();
      const relative = '/proc/self/fd/' + rootHandle.fd + '/ainvr-floor-plans';
      await mkdir(relative, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      dirHandle = await open(relative, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if ((await dirHandle.stat()).dev !== stat.dev) throw unavailable();
      return await fn('/proc/self/fd/' + dirHandle.fd, selected.generation);
    } catch (e) {
      if (e instanceof AlarmConfigError) throw e;
      throw unavailable();
    } finally { await dirHandle?.close(); await rootHandle?.close(); }
  }
  async publish(bytes: Buffer, w: number, h: number): Promise<ImageRef> {
    return this.withDirectory(async (dir, generation) => {
      // Cap files even if writes fail after publication and no transaction commits.
      const entries = await opendir(dir);
      let count = 0;
      for await (const entry of entries) {
        if (/^(?:[0-9a-f-]{36}\.jpg|\.[0-9a-f-]{36}\.tmp)$/.test(entry.name) && ++count >= 512)
          throw new AlarmConfigError('storage_capacity','平面图底图存储已满',503);
      }
      const ref = randomUUID(), temp = path.join(dir, '.' + ref + '.tmp'), final = path.join(dir, ref + '.jpg');
      const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await rename(temp, final); } catch (e) { await unlink(temp).catch(() => undefined); throw e; }
      return { ref, w, h, sha256: createHash('sha256').update(bytes).digest('hex'), generation };
    });
  }
  async read(image: ImageRef): Promise<Buffer> {
    return this.withDirectory(async (dir, generation) => {
      if (generation !== image.generation || !/^[0-9a-f-]{36}$/.test(image.ref)) throw unavailable();
      const file = await open(path.join(dir, image.ref + '.jpg'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 1875000) throw unavailable();
        const bytes = await file.readFile();
        if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw unavailable();
        return bytes;
      } finally { await file.close(); }
    }, image.generation);
  }
  // Incremental cleanup runs under the database mutation lock. Young files
  // survive uncertain commits and concurrent requests for at least one day.
  async cleanup(live: Set<string>, now = Date.now()): Promise<void> {
    await this.withDirectory(async dir => {
      const entries = await opendir(dir);
      let examined = 0, removed = 0;
      for await (const entry of entries) {
        if (++examined > 1024 || removed >= 32) break;
        const match = /^(?:([0-9a-f-]{36})\.jpg|\.([0-9a-f-]{36})\.tmp)$/.exec(entry.name);
        if (!match || live.has(match[1] || match[2]!)) continue;
        const target = path.join(dir,entry.name), stat = await lstat(target);
        if (stat.isFile() && now - stat.mtimeMs >= 86400000) { await unlink(target); removed++; }
      }
    });
  }
}

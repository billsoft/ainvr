/** Shared internal service transport boundaries; never accept browser URLs. */
export interface InternalServiceConnection {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
}
const allowedHosts = new Set(['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal']);
export function endpoint(config: InternalServiceConnection, path: string): URL {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'http:' || !allowedHosts.has(base.hostname) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !base.port || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 30000 ||
      typeof config.apiToken !== 'string' || config.apiToken.length < 32) {
    throw new Error('Invalid internal service connection');
  }
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid internal service path');
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('Invalid internal service path');
  return target;
}
export async function limitedBytes(response: Response, maximum: number): Promise<Buffer> {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024)
    throw new Error('Invalid response limit');
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    const length = response.headers.get('content-length');
    if (length && /^\d+$/.test(length) && Number(length) > maximum) throw new Error('Response too large');
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maximum) throw new Error('Response too large');
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); }
}
export async function limitedJson(response: Response): Promise<unknown> {
  return JSON.parse((await limitedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
}

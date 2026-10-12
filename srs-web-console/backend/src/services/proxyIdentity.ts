import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { FastifyRequest } from 'fastify';

type Identity = { ip: string; protocol: string };
const identities = new WeakMap<FastifyRequest, Identity>();
const normalize = (ip: string | undefined) => {
  if (!ip) return 'unknown';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
};
export const clientIdentity = (req: FastifyRequest): Identity =>
  identities.get(req) ?? { ip: normalize(req.socket.remoteAddress ?? req.ip), protocol: req.protocol };

// Trust exactly the frontend container, not every client on a private subnet.
// The frontend overwrites X-Real-IP and validates any external TLS proxy itself.
export function createProxyIdentity(
  resolve: () => Promise<string[]> = async () => (await lookup('frontend', { all: true })).map(x => x.address),
) {
  let trusted = new Set<string>();
  let expires = 0;
  let pending: Promise<void> | undefined;
  return async (req: FastifyRequest) => {
    // Capture before DNS awaits: a disconnected socket can lose its address.
    // An unknown peer shares a rate-limit bucket and never gains proxy trust.
    const identity = { ip: normalize(req.socket.remoteAddress ?? req.ip), protocol: req.protocol };
    if (performance.now() >= expires) {
      pending ??= (async () => {
        try { trusted = new Set((await resolve()).map(normalize).filter(ip => isIP(ip) !== 0)); }
        catch { trusted = new Set(); } // DNS failure never grants trust to arbitrary proxy headers.
        expires = performance.now() + 5000;
      })().finally(() => { pending = undefined; });
      await pending;
    }
    if (trusted.has(identity.ip)) {
      const real = req.headers['x-real-ip'];
      if (typeof real === 'string' && isIP(real)) identity.ip = normalize(real);
      const protocol = req.headers['x-forwarded-proto'];
      if (protocol === 'http' || protocol === 'https') identity.protocol = protocol;
    }
    identities.set(req, identity);
  };
}

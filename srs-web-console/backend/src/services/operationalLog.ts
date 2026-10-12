/** Structured events without request bodies, credentials or routine polling noise. */
const recent = new Map<string, { at: number; skipped: number }>();
export function operationalLog(level: 'INFO' | 'WARN' | 'ERROR', module: string, message: string,
  category = 'runtime', detail: Record<string, unknown> = {}) {
  const safe = message.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bBearer\s+[^\s,;"}]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|secret|token|authorization|api[_-]?key)["\s]*[:=]["\s]*)([^\s,;}]+)/gi, '$1[REDACTED]').slice(0, 4096);
  const key = `${level}:${module}:${safe}`;
  const now = Date.now(), old = recent.get(key);
  if (category !== 'audit' && old && now - old.at < 60000) { old.skipped++; return; }
  if (recent.size >= 512) recent.delete(recent.keys().next().value!);
  recent.set(key, { at: now, skipped: 0 });
  console.log(JSON.stringify({ ts: now, level, module, category, message: safe,
    count: 1 + (old?.skipped ?? 0), ...detail }));
}

// For a monitoring product an interruption is a blind spot: nobody can say what
// happened in that period. Interruptions must therefore be visible while they
// last and leave a record of how long they lasted, even when the service that
// caused them believes it is "only reconnecting" or "waiting for its source".

export interface AiChannelRow { id: string; name: string; state: string }
export interface RecorderRow {
  id: string; name: string; scheduleEnabled: boolean; scheduleHours: number[];
  recordingState: string; recordingDetail?: string;
}
export interface StreamProblem {
  kind: 'ai' | 'recording'; id: string; name: string; since: number; detail: string;
}
export interface StreamHealthSnapshot { known: boolean; checkedAt: number | null; problems: StreamProblem[] }

/** AI states that mean "meant to run but not producing results". Stopped or idle channels were
 * turned off. A channel retrying cycles error ↔ starting; only running ends the interruption. */
const AI_INTERRUPTED = new Set(['reconnecting', 'error', 'failed', 'starting']);
/** Recorder states that are not a blind spot: writing, or not meant to record now. */
const RECORDING_FINE = new Set(['recording', 'disabled']);

const AI_TEXT: Record<string, string> = { reconnecting: '识别中断，正在反复重连', error: '识别出错，正在重试', failed: '识别出错，正在重试', starting: '识别未能启动，正在重试' };

export function formatGap(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${r} 秒` : `${r} 秒`;
}

export function createStreamHealthMonitor(opts: {
  readAi: () => Promise<AiChannelRow[]>;
  readRecorder: () => Promise<RecorderRow[]>;
  log: (level: 'INFO' | 'WARN', message: string) => void;
  graceMs?: number;
  now?: () => number;
}) {
  const grace = opts.graceMs ?? 30000, now = opts.now ?? Date.now;
  // First time each candidate was seen interrupted; whether it has been reported.
  const seen = new Map<string, StreamProblem & { reported: boolean }>();
  let known = false, checkedAt: number | null = null;

  const candidates = (ai: AiChannelRow[], rec: RecorderRow[], at: number) => {
    const hour = new Date(at).getHours(), found: Omit<StreamProblem, 'since'>[] = [];
    for (const c of ai) if (AI_INTERRUPTED.has(c.state))
      found.push({ kind: 'ai', id: c.id, name: c.name, detail: AI_TEXT[c.state] ?? c.state });
    for (const c of rec) if (c.scheduleEnabled && c.scheduleHours.includes(hour) && !RECORDING_FINE.has(c.recordingState))
      found.push({ kind: 'recording', id: c.id, name: c.name, detail: `录像中断：${c.recordingDetail || c.recordingState}` });
    return found;
  };

  return {
    async poll() {
      let ai: AiChannelRow[], rec: RecorderRow[];
      try { [ai, rec] = await Promise.all([opts.readAi(), opts.readRecorder()]); }
      catch { known = false; return; }
      const at = now(), current = new Set<string>();
      known = true; checkedAt = at;
      for (const c of candidates(ai, rec, at)) {
        const key = `${c.kind}:${c.id}`; current.add(key);
        const entry = seen.get(key) ?? { ...c, since: at, reported: false };
        entry.detail = c.detail; entry.name = c.name; seen.set(key, entry);
        if (!entry.reported && at - entry.since >= grace) {
          entry.reported = true;
          opts.log('WARN', `${c.kind === 'ai' ? 'AI 通道' : '录像'}「${c.name}」中断（${c.detail}），从 ${new Date(entry.since).toLocaleTimeString('zh-CN', { hour12: false })} 开始`);
        }
      }
      for (const [key, entry] of seen) {
        if (current.has(key)) continue;
        seen.delete(key);
        if (entry.reported) opts.log('INFO', `${entry.kind === 'ai' ? 'AI 通道' : '录像'}「${entry.name}」已恢复，共中断 ${formatGap(at - entry.since)}`);
      }
    },
    snapshot(): StreamHealthSnapshot {
      return { known, checkedAt, problems: [...seen.values()].filter(e => e.reported).map(({ reported: _, ...p }) => p) };
    },
  };
}

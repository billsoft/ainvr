import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { request } from '@/api/httpClient';
type Item = {
  source: { id: string; name: string } | null;
  channels: { id: string; name: string }[];
  blocked: boolean;
  stopPending: boolean;
  reason: 'external_motion' | 'camera_control';
  changedAt: string;
};
/** Read-only persistent protection status. Never silently clears warnings on a failed poll. */
export function PtzProtectionNotice({
  sourceId,
  allowNavigation = true,
}: { sourceId?: string; allowNavigation?: boolean }) {
  const [items, setItems] = useState<Item[]>([]),
    [stale, setStale] = useState(false);
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const result = await request<{ items: Item[] }>('/ptz/protection', {
            signal: AbortSignal.timeout(5000),
          });
          if (!Array.isArray(result?.items)) throw Error('invalid protection status');
          if (alive) {
            setItems(result.items);
            setStale(false);
          }
        } catch {
          if (alive) setStale(true);
        }
      }
      if (alive) timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const visible = sourceId
    ? items.filter((i) => i.source?.id === sourceId || i.channels.some((c) => c.id === sourceId))
    : items;
  if (!visible.length) return null;
  return (
    <div
      role="status"
      aria-label="摄像头布防暂停提示"
      className="max-h-44 shrink-0 space-y-2 overflow-y-auto rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
    >
      {visible.length > 1 && <p className="text-xs font-semibold">{visible.length} 处摄像头布防处于暂停保护</p>}
      {visible.map((item, index) => (
        <div key={item.source?.id ?? index} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AlertTriangle size={16} className="shrink-0" />
          <span>
            <strong>{item.source?.name ?? '摄像头'}</strong> ·{' '}
            {item.reason === 'external_motion'
              ? '检测到外部视角变化，已暂停关联告警与计数。'
              : '摄像头视角保护已暂停关联告警与计数。'}
            {item.stopPending ? ' 停止尚未确认。' : ''}
          </span>
          {allowNavigation && item.source ? (
            <a
              className="min-h-11 inline-flex items-center font-medium text-blue-700 underline underline-offset-2"
              href={`/monitor?ptz=${encodeURIComponent(item.source.id)}`}
            >
              核对视角并恢复
            </a>
          ) : (
            <span>请保存布防后，在实时监看的云台面板核对恢复。</span>
          )}
        </div>
      ))}
      {stale && <p className="text-xs">暂停状态暂未更新，请检查服务连接；上次记录仍保留。</p>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ptzService } from '@/api/ptzService';
export function usePtzCatalog() {
  const [ids, setIds] = useState(new Set<string>());
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await ptzService.catalog();
        if (!stopped) setIds(new Set(r.items.filter((c) => c.candidate).map((c) => c.channelId)));
      } catch {
        /* Capability catalogue never blocks playback. */
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 15000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return ids;
}

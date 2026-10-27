import { useCallback, useEffect, useRef, useState } from 'react';
import { ptzService, ptzError, type PtzVector } from '@/api/ptzService';
import { toast } from '@/store/toast';
type ControlLease = { sessionId: string; leaseMs: number; channelId: string };
const zero = { pan: 0, tilt: 0, zoom: 0 };
/** One gesture owns one short control session. No movement retries or queues. */
export function usePtzControl(
  channelId: string,
  identity: string | undefined,
  onChanged: () => void,
) {
  const [state, setState] = useState<'idle' | 'preparing' | 'moving' | 'preset' | 'stopping'>(
    'idle',
  );
  const [error, setError] = useState('');
  const current = useRef({ channelId, identity, onChanged });
  current.current = { channelId, identity, onChanged };
  const live = useRef(true),
    intent = useRef(0),
    active = useRef(false),
    sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    lease = useRef<ControlLease | null>(null);
  const acquiring = useRef<Promise<ControlLease> | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const desired = useRef<PtzVector>(zero),
    started = useRef(0);
  const stop = useCallback(() => {
    if (stopping.current) return stopping.current;
    const task = async () => {
      active.current = false;
      intent.current++;
      clearTimeout(timer.current);
      if (live.current) setState('stopping');
      let session = lease.current;
      if (!session && acquiring.current) {
        try {
          session = await acquiring.current;
        } catch {}
      }
      if (session) {
        try {
          const result = await ptzService.stop(session.channelId, session.sessionId);
          if (!result.stopConfirmed) throw Error('ptz_stop_unconfirmed');
        } catch (e) {
          const text = ptzError(e);
          if (live.current) setError(text);
          toast.error(text);
        }
      }
      if (lease.current?.sessionId === session?.sessionId) lease.current = null;
      if (live.current) {
        setState('idle');
        current.current.onChanged();
      }
    };
    stopping.current = task().finally(() => {
      stopping.current = null;
    });
    return stopping.current;
  }, []);
  const begin = useCallback(
    (vector: PtzVector, presetId?: string) => {
      if (active.current) {
        desired.current = vector;
        return;
      }
      if (acquiring.current || stopping.current || !current.current.identity) return;
      desired.current = vector;
      active.current = true;
      sequence.current = 0;
      started.current = Date.now();
      const epoch = ++intent.current;
      setError('');
      setState('preparing');
      const channel = current.current.channelId;
      const promise = ptzService
        .acquire(channel, current.current.identity)
        .then((session) => ({ ...session, channelId: channel }));
      acquiring.current = promise;
      void promise
        .then(async (session) => {
          lease.current = session;
          acquiring.current = null;
          if (!live.current || !active.current || intent.current !== epoch) {
            if (!stopping.current) {
              await ptzService.stop(channel, session.sessionId).catch(() => undefined);
              if (lease.current?.sessionId === session.sessionId) lease.current = null;
            }
            return;
          }
          const tick = async (first = false): Promise<void> => {
            if (!live.current || !active.current || intent.current !== epoch) return;
            if (Date.now() - started.current > 30000) {
              await stop();
              return;
            }
            try {
              const n = ++sequence.current;
              if (presetId && first) await ptzService.goto(channel, presetId, session.sessionId, n);
              else {
                const result = await ptzService.command(
                  channel,
                  session.sessionId,
                  n,
                  presetId ? zero : desired.current,
                  !!presetId,
                );
                if (result?.motionFinished) {
                  await stop();
                  return;
                }
              }
              if (!live.current || !active.current || intent.current !== epoch) return;
              setState(presetId ? 'preset' : 'moving');
              current.current.onChanged();
              timer.current = setTimeout(
                () => void tick(),
                Math.min(350, Math.floor(session.leaseMs / 3)),
              );
            } catch (e) {
              if (live.current) setError(ptzError(e));
              await stop();
            }
          };
          await tick(true);
        })
        .catch((e) => {
          acquiring.current = null;
          active.current = false;
          if (live.current) {
            setError(ptzError(e));
            setState('idle');
            current.current.onChanged();
          }
        });
    },
    [stop],
  );
  useEffect(() => {
    live.current = true;
    const cancel = () => {
      void stop();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', cancel);
    return () => {
      live.current = false;
      active.current = false;
      intent.current++;
      clearTimeout(timer.current);
      const session = lease.current;
      if (session)
        void ptzService.stop(session.channelId, session.sessionId).catch(() => undefined);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', cancel);
    };
  }, [channelId, stop]);
  return {
    state,
    error,
    begin,
    stop,
    moving: state === 'moving' || state === 'preset',
    preparing: state === 'preparing',
  };
}

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ptzError, ptzService, type PtzInfo } from '@/api/ptzService';
import type { usePtzControl } from './usePtzControl';
import type { usePtzFollow } from './usePtzFollow';

interface Options {
  mode: 'aim' | 'follow' | 'manual';
  channelId: string;
  identity?: string;
  protocol?: PtzInfo['protocol'];
  permitted?: boolean;
  speed: number;
  disabled: boolean;
  follow: Pick<ReturnType<typeof usePtzFollow>, 'selectedId' | 'pick' | 'stop'>;
  control: Pick<ReturnType<typeof usePtzControl>, 'zoomStep' | 'stopConfirmed' | 'state'>;
}

interface Gesture {
  cancelled: boolean;
  brake: () => Promise<boolean>;
  stopping?: Promise<boolean>;
  wake?: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const prepareMs = 3000;
const pulseMs = 180;
// Operator buttons only. GB has 15 nonzero zoom gears. This is a button
// default for hardware validation, independent of the encoder's minimum (1).
const gbButtonFloor = 8 / 15;
const gbPulseMs = 900;
const choose = '变焦已停止，请点选目标继续跟踪。';

function brake(g: Gesture): Promise<boolean> {
  return g.stopping ??= g.brake().catch(() => false);
}

async function buttonPulse(g: Gesture, channel: string, lease: Awaited<ReturnType<typeof ptzService.acquire>>,
  zoom: number, gb: boolean) {
  const {sessionId, leaseMs} = lease;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw Error('ptz_session_expired');
  const duration = gb ? gbPulseMs : Math.min(pulseMs, leaseMs);
  let sentAt = performance.now();
  const end = sentAt + duration;
  const done = new Promise<void>(resolve => {
    g.wake = resolve;
    g.timer = setTimeout(resolve, duration);
  });
  // Stop at the original deadline even when a movement or renewal reply stalls.
  const stopping = done.then(() => brake(g));
  let error: unknown;
  try {
    await ptzService.command(channel, sessionId, 1, {pan:0, tilt:0, zoom}, false);
    let sequence = 1;
    while (gb && !g.cancelled && !g.stopping && sentAt + leaseMs <= end) {
      let renewal: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([done, new Promise<void>(resolve => {
        renewal = setTimeout(resolve, Math.max(0, sentAt + leaseMs / 2 - performance.now()));
      })]);
      clearTimeout(renewal);
      const now = performance.now();
      if (g.cancelled || g.stopping || now >= end) break;
      if (now >= sentAt + leaseMs) throw Error('ptz_session_expired');
      sentAt = now;
      // The GB gateway renews its watchdog without sending another SIP Move.
      await ptzService.command(channel, sessionId, ++sequence, {pan:0, tilt:0, zoom:0}, true);
    }
  } catch (cause) {
    error = cause;
    g.wake?.();
  }
  return {stopped:await stopping, error};
}

export function usePtzModeZoom(options: Options) {
  const { mode, channelId, identity, protocol, permitted = true } = options;
  const latest = useRef(options);
  const live = useRef(false);
  const active = useRef<Gesture | null>(null);
  const aim = useRef<Gesture | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useLayoutEffect(() => { latest.current = options; });

  const cancel = useCallback(async (): Promise<boolean> => {
    const g = active.current ?? aim.current;
    if (!g) return true;
    g.cancelled = true;
    clearTimeout(g.timer);
    g.wake?.();
    const confirmed = await brake(g);
    if (active.current !== g && aim.current !== g) return confirmed;
    if (confirmed) {
      active.current = null;
      aim.current = null;
    } else {
      g.stopping = undefined; // A subsequent cancel retries this exact owner.
      if (live.current) setNotice(ptzError(Error('ptz_stop_unconfirmed')));
    }
    if (live.current) setBusy(!confirmed);
    return confirmed;
  }, []);

  useLayoutEffect(() => {
    live.current = true;
    setBusy(!!active.current || !!aim.current?.cancelled);
    setNotice('');
    const leave = () => { void cancel(); };
    const hidden = () => { if (document.hidden) leave(); };
    window.addEventListener('blur', leave);
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      live.current = false;
      leave();
      window.removeEventListener('blur', leave);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
    };
  // A polled busy flag may describe our own lease. It gates the next click,
  // while scope changes and explicit cancel fence an already accepted pulse.
  }, [channelId, identity, mode, protocol, permitted, cancel]);

  const step = useCallback(async (direction: 1 | -1): Promise<void> => {
    const now = latest.current;
    if (!live.current || now.disabled || now.permitted === false || now.protocol !== protocol ||
        now.channelId !== channelId || now.identity !== identity ||
        now.mode !== mode || !identity || !channelId || mode === 'manual' || document.hidden ||
        active.current || aim.current?.cancelled || ![1,-1].includes(direction) ||
        !Number.isFinite(now.speed) || now.speed <= 0 || now.speed > 1) return;
    const gb = protocol === 'gb28181';
    const zoom = direction * (gb ? Math.max(gbButtonFloor, now.speed) : now.speed);
    setNotice('');
    if (mode === 'aim' && !gb) {
      // zoomStep owns the wheel pulse and fences an in-flight point gesture.
      // Keep its stop handle even after zoomStep returns (acquire can still be pending).
      const g = aim.current ??= { cancelled:false, brake:now.control.stopConfirmed };
      try { await now.control.zoomStep(zoom); }
      catch (error) { if (live.current && !g.cancelled) setNotice(ptzError(error)); }
      return;
    }

    const original = mode === 'follow' ? now.follow.selectedId : null;
    const releaseOwner = mode === 'follow' ? now.follow.stop : now.control.stopConfirmed;
    const g: Gesture = {cancelled:false, brake:releaseOwner};
    active.current = g;
    setBusy(true);
    const deadline = performance.now() + prepareMs;
    const expire = () => {
      if (active.current !== g || g.cancelled) return;
      setNotice('变焦准备超时，请重新点按。');
      void cancel();
    };
    const current = () => !g.cancelled && active.current === g && live.current;
    const ready = () => {
      if (!current()) return false;
      if (performance.now() >= deadline) { expire(); return false; }
      return true;
    };
    g.timer = setTimeout(expire, prepareMs);
    try {
      const releasing = releaseOwner().catch(() => false);
      g.brake = () => releasing;
      const confirmed = await releasing;
      g.brake = releaseOwner;
      if (!current()) return;
      if (!confirmed) {
        clearTimeout(g.timer);
        g.cancelled = true;
        setNotice(ptzError(Error('ptz_stop_unconfirmed')));
        return;
      }
      if (!ready()) return;
      const acquiring = ptzService.acquire(channelId, identity);
      g.brake = async () => {
        const lease = await acquiring.catch(() => null);
        return !lease || (await ptzService.stop(channelId, lease.sessionId)).stopConfirmed === true;
      };
      const lease = await acquiring;
      if (!ready()) return;
      if (lease.identity !== identity) throw Error('ptz_source_changed');
      clearTimeout(g.timer);
      const {stopped, error} = await buttonPulse(g, channelId, lease, zoom, gb);
      if (!current()) return;
      if (!stopped) {
        g.cancelled = true;
        g.stopping = undefined;
        setNotice(ptzError(Error('ptz_stop_unconfirmed')));
        return;
      }
      if (error) setNotice(ptzError(error));
      else if (mode === 'follow') {
        setNotice(choose);
        const follow = latest.current.follow;
        if (original && (!follow.selectedId || follow.selectedId === original)) follow.pick(original);
      }
      active.current = null;
      setBusy(false);
    } catch (error) {
      if (current()) {
        setNotice(ptzError(error));
        await cancel();
      }
    } finally {
      clearTimeout(g.timer);
    }
  }, [channelId, identity, mode, protocol, cancel]);

  return {
    step, cancel, busy: busy || (mode === 'aim' && !!aim.current && options.control.state !== 'idle'),
    notice: notice === choose && options.follow.selectedId ? '' : notice,
  };
}

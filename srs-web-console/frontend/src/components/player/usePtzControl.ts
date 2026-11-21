import { useCallback, useEffect, useRef, useState } from 'react';
import { ptzService, ptzError, type PtzCapabilities, type PtzVector } from '@/api/ptzService';
import { toast } from '@/store/toast';
import { flowCalibrationCoverage, runFlowCenter, runFlowCalibrationProbe, type VisualCenterCalibrationSnapshot } from './ptzFlowCenter';
import { captureFlowView, CenterObservationError } from './ptzFlowFrames';
import type { VisualCalibrationContext } from '@/api/ptzService';

const estimator = 'neuflow-v1' as const;
const maxSegments = 24;
const needsCalibration = '请先完成当前倍率标定，再点击画面定位。';

function currentScope(data: VisualCalibrationContext | undefined): data is VisualCalibrationContext {
  return data?.estimator === estimator && !!data.scope && Number.isSafeInteger(data.epoch) && data.epoch >= 0;
}

const zero = { pan: 0, tilt: 0, zoom: 0 };
type Point = { x: number; y: number };
type Kind = 'manual' | 'point' | 'preset' | 'wheel' | 'calibration';
type State = 'idle' | 'preparing' | 'moving' | 'preset' | 'stopping';

// Release is shared by the pulse deadline, cancellation and cleanup. A late
// acquisition always releases the original channel, even after unmount.
function acquireLease(channel: string, identity: string, calibrationEpoch?: number) {
  let sessionId: string | undefined;
  const acquisition = calibrationEpoch === undefined ? ptzService.acquire(channel, identity)
    : ptzService.acquire(channel, identity, calibrationEpoch);
  const ready = acquisition.then(session => {
    sessionId = session.sessionId;
    return session;
  });
  let releasing: Promise<boolean> | undefined;
  async function sendStop(id: string) {
    const result = await ptzService.stop(channel, id);
    if (!result.stopConfirmed) throw Error('ptz_stop_unconfirmed');
    return true;
  }
  let releaseFailed = false;
  function release(retryFailed = false) {
    if (retryFailed && releaseFailed) {
      releasing = undefined;
      releaseFailed = false;
    }
    return releasing ??= (sessionId ? sendStop(sessionId) :
      ready.then(session => sendStop(session.sessionId), () => false)).catch(error => {
        releaseFailed = true;
        throw error;
      });
  }
  return { ready, release };
}

interface Gesture {
  kind: Kind;
  channel: string;
  identity: string;
  vector: PtzVector;
  abort: AbortController;
  lease?: ReturnType<typeof acquireLease>;
  stopping?: Promise<boolean>;
  timer?: ReturnType<typeof setTimeout>;
  completed?: (arrived: boolean) => void;
  point?: Point;
  backgroundStopTicket?: number;
}

export function usePtzControl(channelId: string, identity: string | undefined, onChanged: () => void) {
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pendingPoint = useRef<{
    owner: Gesture; ticket: number; point: Point; launch: () => void;
  } | null>(null);
  const current = useRef({ channelId, identity, onChanged });
  current.current = { channelId, identity, onChanged };
  const active = useRef<Gesture | null>(null);
  const live = useRef(true);
  const generation = useRef(0);
  const lastWheel = useRef(0);
  const failedStop = useRef<Gesture | null>(null);
  const [calibration, setCalibration] = useState({running: false, progress: 0, total: maxSegments, ready: 0,
    message: '尚未读取标定'});
  const calibrationRead = useRef(0);

  const refreshCalibration = useCallback(async (video: HTMLVideoElement | null | undefined) => {
    if (!video?.videoWidth || !video.videoHeight || !identity || active.current) return;
    const ticket = ++calibrationRead.current;
    try {
      const data = await ptzService.visualCalibration(channelId, identity, video.videoWidth, video.videoHeight,
        new AbortController().signal, estimator);
      if (!live.current || ticket !== calibrationRead.current || active.current ||
          current.current.channelId !== channelId || current.current.identity !== identity) return;
      const ready = currentScope(data) ? flowCalibrationCoverage(data.snapshot).filter(d => d.ready).length : 0;
      setCalibration(s => ({...s, ready, message: ready === 4 ? '当前倍率四方向标定可用' : needsCalibration}));
    } catch {
      if (live.current && ticket === calibrationRead.current && !active.current)
        setCalibration(s => ({...s, ready: 0, message: '暂时无法读取当前倍率标定，请稍后重试。'}));
    }
  }, [channelId, identity]);

  function flowMotor(g: Gesture, epoch: number) {
    const signal = g.abort.signal;
    let sequence = 0;
    let started = 0;
    const debug = new URLSearchParams(window.location.search).get('ptzDebug') === '1';
    const phase = g.kind === 'calibration' ? 'calibration' : 'open-loop';
    function check() {
      signal.throwIfAborted();
      if (active.current !== g) throw new DOMException('Gesture superseded', 'AbortError');
    }
    return {
      async prepare() {
        check();
        g.lease = acquireLease(g.channel, g.identity, epoch);
        const session = await g.lease.ready;
        check();
        return session.leaseMs;
      },
      async move(vector: PtzVector) {
        check();
        const lease = g.lease!;
        const session = await lease.ready;
        check();
        if (g.lease !== lease) throw new DOMException('Lease superseded', 'AbortError');
        if (!sequence) started = performance.now();
        setState('moving');
        current.current.onChanged();
        if (debug) console.debug('[ptz-center] ' + JSON.stringify({phase, outcome: 'move', vector, elapsedMs: Math.round(performance.now() - started)}));
        return ptzService.command(g.channel, session.sessionId, ++sequence, vector);
      },
      async release() {
        const lease = g.lease;
        if (!lease) return;
        const durationMs = sequence ? Math.round(performance.now() - started) : 0;
        await lease.release();
        if (debug) console.debug('[ptz-center] ' + JSON.stringify({phase, outcome: 'stopped', durationMs}));
        if (g.lease === lease) g.lease = undefined;
        signal.throwIfAborted();
      },
    };
  }

  async function calibrate(video: HTMLVideoElement | null | undefined) {
    if (!video?.videoWidth || !video.videoHeight || active.current || failedStop.current) return;
    const g = start('calibration', zero);
    if (!g) return;
    const runId = ++calibrationRead.current;
    const signal = g.abort.signal;
    const width = video.videoWidth, height = video.videoHeight;
    const source = video.currentSrc, stream = video.srcObject;
    setCalibration({running: true, progress: 0, total: maxSegments, ready: 0, message: '正在准备四方向标定'});
    g.timer = setTimeout(() => { void finish(g); }, 180000);
    try {
      let context = await ptzService.visualCalibration(g.channel, g.identity, width, height, signal, estimator);
      signal.throwIfAborted();
      if (!currentScope(context)) throw Error('ptz_calibration_stale');
      const empty: VisualCenterCalibrationSnapshot = {version: 1, records: []};
      // An explicit retry resumes incomplete samples. Recalibrating a complete scope starts fresh.
      let snapshot = flowCalibrationCoverage(context.snapshot).every(d => d.ready) ? empty : context.snapshot ?? empty;
      const directions = [['pan', 1, '向右'], ['pan', -1, '向左'], ['tilt', -1, '向下'], ['tilt', 1, '向上']] as const;
      const calibrationWarmup = {ready: false};
      let cursor = 0;
      for (let i = 0; i < maxSegments; i++) {
        signal.throwIfAborted();
        if (video.videoWidth !== width || video.videoHeight !== height || video.currentSrc !== source || video.srcObject !== stream)
          throw new CenterObservationError('视频来源或尺寸已改变，请重新开始标定。');
        const coverage = flowCalibrationCoverage(snapshot);
        if (coverage.every(d => d.ready)) break;
        const ready = (axis: string, sign: number) => coverage.some(d => d.axis === axis && d.sign === sign && d.ready);
        while (ready(directions[cursor]![0], directions[cursor]![1])) cursor = (cursor + 1) % directions.length;
        const [axis, sign, name] = directions[cursor]!;
        cursor = (cursor + 1) % directions.length;
        setCalibration(s => ({...s, progress: i, message: '正在标定' + name + ' · ' + (i + 1) + '/' + maxSegments}));
        const frames = await captureFlowView(video, signal);
        signal.throwIfAborted();
        const measured = await runFlowCalibrationProbe(frames, axis, sign, signal, {
          ...flowMotor(g, context.epoch),
          calibrationWarmup,
          calibrationStore: {load: () => snapshot, save: next => { snapshot = next; }},
          measure: (a, b, sampleSignal) => ptzService.measureFlow(g.channel, g.identity, context.epoch, a.jpeg, b.jpeg, sampleSignal),
        });
        signal.throwIfAborted();
        if (measured) {
          const saved = await ptzService.saveVisualCalibration(g.channel, g.identity, width, height, context, snapshot, estimator);
          signal.throwIfAborted();
          context = {...context, snapshot, revision: saved.revision};
        }
        setCalibration(s => ({...s, progress: i + 1, ready: flowCalibrationCoverage(snapshot).filter(d => d.ready).length}));
      }
      const complete = flowCalibrationCoverage(snapshot).every(d => d.ready);
      const message = complete ? '四方向标定完成，可点击画面定位' : '部分方向样本不足，请避开限位并继续标定。';
      setCalibration(s => ({...s, message}));
      setNotice(message);
    } catch (e) {
      if (!signal.aborted) {
        const message = e instanceof CenterObservationError ? e.message : ptzError(e);
        setCalibration(s => ({...s, message}));
        setNotice(message);
      } else if (live.current && calibrationRead.current === runId && current.current.channelId === g.channel && current.current.identity === g.identity)
        setCalibration(s => ({...s, message: '标定已停止，已保存的样本保留'}));
    } finally {
      await finish(g);
      if (live.current && calibrationRead.current === runId && current.current.channelId === g.channel && current.current.identity === g.identity)
        setCalibration(s => ({...s, running: false}));
    }
  }

  const finish = useCallback((g: Gesture, arrived = false, positioningTimedOut = false): Promise<boolean> => {
    if (g.stopping) return g.stopping;
    g.abort.abort();
    clearTimeout(g.timer);
    if (live.current) setState('stopping');
    const release = g.lease?.release();
    g.stopping = (async () => {
      try {
        const confirmed = await release;
        failedStop.current = null;
        if (positioningTimedOut && confirmed && live.current && active.current === g &&
            current.current.channelId === g.channel && current.current.identity === g.identity)
          setNotice('已停止等待，设备未确认到位；请核对画面');
      } catch (e) {
        failedStop.current = g;
        const text = ptzError(e);
        if (live.current) setError(text);
        toast.error(text);
      }
      if (active.current !== g) return false;
      active.current = null;
      if (live.current) { setState('idle'); current.current.onChanged(); }
      g.completed?.(arrived && !failedStop.current);
      return !failedStop.current;
    })();
    return g.stopping;
  }, []);
  const stopConfirmed = useCallback((retryFailed = false) => {
    ++generation.current;
    pendingPoint.current = null;
    if (active.current) return finish(active.current);
    const failed = failedStop.current;
    if (!retryFailed || !failed?.lease) return Promise.resolve(!failed);
    return failed.lease.release(true).then(ok => {
      if (ok && failedStop.current === failed) {
        failedStop.current = null;
        if (live.current) setError('');
      }
      return ok;
    }, () => false);
  }, [finish]);
  const stop = useCallback(async () => { await stopConfirmed(); }, [stopConfirmed]);

  async function priorityStop() {
    const failed = failedStop.current;
    void stopConfirmed(); // A pending acquisition must still release its exact lease.
    const reply = await ptzService.stop(channelId, null);
    if (!reply.stopConfirmed) throw Error('ptz_stop_unconfirmed');
    if (failed && failedStop.current === failed && !active.current && live.current &&
        current.current.channelId === channelId && current.current.identity === identity) {
      failedStop.current = null;
      setError('');
    }
  }

  function start(kind: Kind, vector: PtzVector, completed?: Gesture['completed']) {
    const { channelId: channel, identity: id } = current.current;
    if (!id || !live.current || active.current || failedStop.current) { completed?.(false); return; }
    const g: Gesture = { kind, channel, identity: id, vector, abort: new AbortController(), completed };
    active.current = g;
    setError('');
    setNotice('');
    setState('preparing');
    return g;
  }

  function fail(g: Gesture, e: unknown) {
    if (g.abort.signal.aborted) return;
    setError(e instanceof CenterObservationError ? e.message : ptzError(e));
    void finish(g);
  }

  function begin(vector: PtzVector, presetId?: string | {id:string;fingerprint:string}, completed?: Gesture['completed'], point?: Point, wheel = false) {
    const kind = point ? 'point' : presetId ? 'preset' : wheel ? 'wheel' : 'manual';
    const previous = active.current;
    if (previous?.kind === 'point' && (kind === 'manual' || kind === 'wheel')) {
      const ticket = ++generation.current;
      void finish(previous).then(ok => {
        if (ok && live.current && generation.current === ticket) begin(vector, presetId, completed, point, wheel);
        else completed?.(false);
      });
      return;
    }
    if (previous?.kind === 'manual' && kind === 'manual') previous.vector = vector;
    const g = start(kind, vector, completed);
    if (!g) return;
    g.point = point;
    const signal = g.abort.signal;
    const lease = g.lease = acquireLease(g.channel, g.identity);
    const started = Date.now();
    const positioning = !!presetId || !!point;
    if (positioning) {
      // A pending acquisition, Goto or renewal must not postpone Stop.
      const deadline = setTimeout(() => { void finish(g, false, true); }, 30000);
      signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
    }
    void lease.ready.then(async session => {
      let sequence = 0;
      const tick = async (): Promise<void> => {
        if (signal.aborted) return;
        if (Date.now() - started >= 30000) { await finish(g, false, positioning); return; }
        const n = ++sequence;
        if (point && n === 1) await ptzService.center(g.channel, session.sessionId, n, point.x, point.y);
        else if (presetId && n === 1) {
          if (typeof presetId === 'string') await ptzService.goto(g.channel, presetId, session.sessionId, n);
          else await ptzService.goto(g.channel, presetId.id, session.sessionId, n, presetId.fingerprint);
        }
        else {
          const result = await ptzService.command(g.channel, session.sessionId, n, positioning ? zero : g.vector, positioning);
          if (signal.aborted) return;
          if (result?.motionFinished) { await finish(g, true); return; }
        }
        if (signal.aborted) return;
        setState(positioning ? 'preset' : 'moving');
        current.current.onChanged();
        const interval = Math.min(wheel ? 180 : 350, Math.floor(session.leaseMs / 3));
        g.timer = setTimeout(() => {
          if (wheel && Date.now() - lastWheel.current >= interval) void finish(g);
          else void tick().catch(e => fail(g, e));
        }, interval);
      };
      await tick();
    }).catch(e => fail(g, e));
  }

  function drive(steer: () => PtzVector | null, budgetMs: number,
    prepare: (signal: AbortSignal, brake: () => void) => Promise<void>) {
    return new Promise<boolean>(resolve => {
      const g = start('manual', zero, resolve);
      if (!g) return;
      const deadline = performance.now() + budgetMs;
      const brake = () => { void finish(g, true); };
      const limit = setTimeout(() => void finish(g), budgetMs);
      g.abort.signal.addEventListener('abort', () => clearTimeout(limit), {once:true});
      const lease = g.lease = acquireLease(g.channel, g.identity);
      void lease.ready.then(async session => {
        if (g.abort.signal.aborted) return;
        await prepare(g.abort.signal, brake);
        if (g.abort.signal.aborted) return;
        let sequence = 0;
        const tick = async (): Promise<void> => {
          if (g.abort.signal.aborted) return;
          if (performance.now() >= deadline) { await finish(g); return; }
          const vector = steer();
          if (!vector) { await finish(g, true); return; }
          await ptzService.command(g.channel, session.sessionId, ++sequence, vector);
          if (g.abort.signal.aborted) return;
          setState('moving');
          g.timer = setTimeout(() => void tick().catch(e => fail(g,e)), Math.min(180, session.leaseMs / 3));
        };
        current.current.onChanged();
        await tick();
      }).catch(e => fail(g,e));
    });
  }

  function centerPoint(x: number, y: number, video: HTMLVideoElement | null | undefined,
    caps: Pick<PtzCapabilities, 'pointCenter' | 'panTilt'> | undefined) {
    if (![x, y].every(v => Number.isFinite(v) && Math.abs(v) <= 1)) return;
    const native = !!caps?.pointCenter;
    if (!native && (!caps?.panTilt || !video)) return;
    const owner = active.current;
    if (failedStop.current || !live.current || !current.current.identity || (owner && owner.kind !== 'point')) return;
    const queued = pendingPoint.current;
    const latest = queued && queued.ticket === generation.current ? queued.point : owner?.point;
    if (latest && Math.abs(x - latest.x) < 1e-6 && Math.abs(y - latest.y) < 1e-6) return;

    const ticket = ++generation.current;
    const stopped = owner && finish(owner);
    const click = { x, y };
    const launch = () => {
      if (native) begin(zero, undefined, undefined, click);
      else startOpenLoop(click, video?.videoWidth ?? 0, video?.videoHeight ?? 0);
    };
    if (!owner || !stopped) { launch(); return; }
    // Exactly one waiter per stopping gesture; newer clicks replace its payload.
    pendingPoint.current = { owner, ticket, point: click, launch };
    if (queued?.owner === owner) return;
    void stopped.then(ok => {
      const next = pendingPoint.current;
      if (next?.owner !== owner) return;
      pendingPoint.current = null;
      if (ok && next.ticket === generation.current && live.current && !active.current &&
          current.current.identity === owner.identity && current.current.channelId === owner.channel) next.launch();
    });
  }

  function startOpenLoop(click: Point, width: number, height: number) {
    const g = start('point', zero);
    if (!g) return;
    g.point = click;
    const signal = g.abort.signal;
    void (async () => {
      if (!width || !height) return 'needs-calibration';
      const history = await ptzService.visualCalibration(g.channel, g.identity, width, height, signal, estimator);
      signal.throwIfAborted();
      const ready = currentScope(history) ? flowCalibrationCoverage(history.snapshot).filter(d => d.ready).length : 0;
      setCalibration(s => ({...s, ready, message: ready === 4 ? '当前倍率四方向标定可用' : needsCalibration}));
      if (!currentScope(history) || !ready) return 'needs-calibration';
      return runFlowCenter({width, height}, click, signal, {
        ...flowMotor(g, history.epoch),
        calibrationStore: {load: () => history.snapshot},
      });
    })().then(outcome => {
      if (signal.aborted || active.current !== g) return;
      if (outcome === 'needs-calibration') setNotice(needsCalibration);
      if (outcome === 'partial') setNotice('已按标定部分转动并停止，请核对画面位置。');
      if (outcome === 'estimated') setNotice('已按历史标定转动并停止。');
      return finish(g);
    }, e => {
      if (signal.aborted) return;
      if (e instanceof Error && e.message === 'ptz_calibration_stale') {
        setNotice(needsCalibration);
        setCalibration(s => ({...s, ready: 0, message: needsCalibration}));
        void finish(g);
      } else fail(g, e);
    });
  }

  useEffect(() => {
    live.current = true;
    ++calibrationRead.current;
    setCalibration({running: false, progress: 0, total: maxSegments, ready: 0, message: '尚未读取标定'});
    let interrupted: Gesture | undefined;
    const cancel = (event: Event) => {
      const g = active.current;
      if ((!g || interrupted === g) && !pendingPoint.current) return;
      const explain = g?.kind === 'point' && !g.stopping && event.type !== 'pagehide';
      if (explain) interrupted = g;
      const reason = event.type === 'visibilitychange' ? '页面已隐藏' : '窗口已失去焦点';
      const stopped = stopConfirmed();
      const ticket = generation.current;
      if (g && explain) g.backgroundStopTicket = ticket;
      void stopped.then(ok => {
        if (ok && explain && live.current && generation.current === ticket && !active.current)
          setNotice(reason + '，已取消点击居中并确认停转。');
      });
    };
    const hidden = (event: Event) => { if (document.hidden) cancel(event); };
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', cancel);
    return () => {
      live.current = false;
      void stopConfirmed();
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', cancel);
    };
  }, [channelId, identity, stopConfirmed]);

  return {
    state, error, notice, begin, drive, centerPoint, stop, stopConfirmed, priorityStop, calibration, calibrate, refreshCalibration,
    clearFeedback: () => { if (!failedStop.current) { setError(''); setNotice(''); } },
    zoomStep: async (zoom: number) => {
      lastWheel.current = Date.now();
      const previous = active.current;
      if (previous?.kind === 'wheel' && !previous.stopping) { previous.vector = { ...zero, zoom }; return; }
      if (previous && previous.kind !== 'point' && !previous.stopping) return;
      const ticket = ++generation.current;
      if (previous && !await finish(previous)) return;
      if (generation.current === ticket && live.current)
        begin({ ...zero, zoom }, undefined, undefined, undefined, true);
    },
    stopScreenGesture: (wheelOnly = false) => {
      const g = active.current;
      if (wheelOnly && g?.backgroundStopTicket === generation.current) return;
      if (!wheelOnly || pendingPoint.current?.ticket !== generation.current) ++generation.current;
      if (g && (g.kind === 'wheel' || (!wheelOnly && g.kind === 'point'))) void finish(g);
    },
    moving: state === 'moving' || state === 'preset',
    preparing: state === 'preparing',
  };
}

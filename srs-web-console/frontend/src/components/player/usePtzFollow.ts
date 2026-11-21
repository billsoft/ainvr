import { useLayoutEffect, useRef, useState } from 'react';
import { ptzError, ptzService } from '@/api/ptzService';
import type { ReadDisplayedTracks } from './AiDetectionOverlay';
import { largestPatrolTarget, type PatrolLabel } from './ptzPatrol';

interface Options {
  camera: string;
  processor?: string;
  identity?: string;
  enabled: boolean;
  displayedTracks?: { current: ReadDisplayedTracks | null };
  automatic?: { label: PatrolLabel; ended: (resume: boolean, message: string) => void };
}

interface State {
  selectedId: string | null;
  pickReady: boolean;
  ownsLease: boolean;
  statusText: string;
}

type Source = { camera: string; processor: string; identity: string; automatic?: Options['automatic'] };
const idle: State = { selectedId: null, pickReady: false, ownsLease: false, statusText: '' };
const idleMs = 20_000;
const trackingPeriodMs = 125;
const legacyGapMs = 650;
const selectionHoldMs = 4000;
const waiting = '目标暂时不可见，已暂停跟踪。';
const expired = '跟踪准备已超时，点击目标可重新开始。';
const reselect = '目标编号已更新，请再次点击画面中的目标。';

function uniqueIds(ids: (string | undefined)[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  for (const id of duplicates) seen.delete(id);
  return seen;
}

class FollowControl {
  publish?: (state: State) => void;
  source?: Source;
  private readonly read: ReadDisplayedTracks;
  private state = idle;
  private generation = 0;
  private lease?: Promise<{ camera: string; sessionId: string }>;
  private releasing?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private animation?: number;
  private candidates = new Set<string>();
  private poll?: () => Promise<void>;
  private busy = false;

  constructor(read: ReadDisplayedTracks) { this.read = read; }

  private update(state: State) {
    this.state = state;
    this.publish?.(state);
  }

  private visible(id: string) {
    return this.read().filter(d => !d.predicted && !d.lowConfidence && d.track_id === id).length === 1;
  }

  stop = (): Promise<boolean> => this.release('');

  private release(message: string): Promise<boolean> {
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    if (this.animation !== undefined) cancelAnimationFrame(this.animation);
    this.animation = undefined;
    this.candidates.clear();
    this.poll = undefined;
    this.busy = false;
    const pending = this.lease;
    this.update({ ...idle, ownsLease: !!pending, pickReady: !pending && !!this.source, statusText: message });
    if (this.releasing) return this.releasing;
    if (!pending) return Promise.resolve(true);
    this.releasing = (async () => {
      const lease = await pending.catch(() => undefined);
      if (lease) {
        try {
          const result = await ptzService.stop(lease.camera, lease.sessionId);
          if (!result.stopConfirmed) throw Error('ptz_stop_unconfirmed');
        } catch (error) {
          // Retain the exact lease for retry. A null stop could stop another operator.
          this.update({ ...idle, ownsLease: true, statusText: ptzError(error) });
          return false;
        }
      }
      this.lease = undefined;
      this.update({ ...this.state, ownsLease: false, pickReady: !!this.source });
      return true;
    })().finally(() => { this.releasing = undefined; });
    return this.releasing;
  }

  async prepare() {
    const released = this.stop();
    const generation = this.generation;
    if (this.source && !document.hidden) this.update({ ...this.state, pickReady: false, statusText: '正在准备跟踪…' });
    if (await released && generation === this.generation && this.source && !document.hidden) {
      await this.start(this.source, null);
    }
  }

  pick = (id: string) => {
    if (!this.source || !this.state.pickReady || document.hidden || this.releasing ||
        !id || !this.visible(id) || id === this.state.selectedId) return;
    if (!this.lease) {
      void this.start(this.source, id); // First click after an idle timeout.
      return;
    }
    if (!this.poll || !this.candidates.has(id)) return;
    this.update({ ...this.state, selectedId: id, statusText: '正在确认所选目标…' });
    if (!this.busy) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.poll, 0);
    }
  };

  private async start({camera, processor, identity, automatic}: Source, initialId: string | null) {
    const generation = ++this.generation;
    const end = (message: string, resume = false) => {
      if (generation !== this.generation) return;
      const release = this.release(message);
      const releasingGeneration = this.generation;
      if (automatic) void release.then(confirmed => {
        if (releasingGeneration === this.generation)
          automatic.ended(confirmed && resume, confirmed ? message : ptzError(Error('ptz_stop_unconfirmed')));
      });
    };
    this.update({ ...idle, selectedId: initialId, ownsLease: true, statusText: '正在准备跟踪…' });
    try {
      this.lease = ptzService.followSession(camera, identity, processor)
        .then(({ sessionId }) => ({ camera, sessionId }));
      const { sessionId } = await this.lease;
      if (generation !== this.generation) return;
      this.expiry = setTimeout(() => end(expired, true), automatic ? 3500 : idleMs);
      let active: string | null = null;
      let displayEpoch = 0;
      let held = false;
      let braking = false;
      let gapUntil = 0;
      let forgetting = false;
      const current = () => generation === this.generation;
      const lost = () => end(ptzError(Error('ptz_follow_target_lost')), true);
      const schedule = (delay:number) => {
        if (!current() || this.busy || braking) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(tick, delay);
      };
      const chooseAgain = (epoch:number) => {
        if (automatic) { lost(); return; }
        displayEpoch = epoch;
        active = null;
        held = braking = forgetting = false;
        gapUntil = 0;
        if (this.animation !== undefined) cancelAnimationFrame(this.animation);
        this.animation = undefined;
        this.candidates.clear();
        clearTimeout(this.expiry);
        this.expiry = setTimeout(() => { void this.release(expired); }, idleMs);
        this.update({...idle,ownsLease:true,statusText:reselect});
        schedule(0);
      };
      const waitForTarget = (remaining?:number) => {
        const ms = remaining === undefined ? legacyGapMs : Math.min(remaining,selectionHoldMs);
        const deadline = performance.now() + ms;
        if (!gapUntil || deadline < gapUntil) {
          gapUntil = deadline;
          clearTimeout(this.expiry);
          this.expiry = setTimeout(remaining === undefined ? lost : () => interrupt(true), ms);
        }
        this.update({ ...this.state, pickReady:false, statusText:waiting });
      };
      const interrupt = (forget=false) => {
        if (!current() || forgetting || (!forget && held)) return;
        forgetting = forget;
        held = braking = true;
        const epoch = ++displayEpoch;
        const track = forget ? undefined : active ?? undefined;
        const retryUntil = performance.now()+2000;
        this.update({ ...this.state, selectedId:forget ? null : this.state.selectedId,
          pickReady:false,statusText:forget ? reselect : '正在制动…' });
        const send = async () => {
          if (!current() || epoch!==displayEpoch) return;
          try {
            const ack = await ptzService.followStep(camera,sessionId,track,true,epoch);
            if (!current() || epoch!==displayEpoch) return;
            if (ack.reselect && ack.displayEpoch !== undefined) { chooseAgain(ack.displayEpoch); return; }
            if (forget || ack.moving!==false) throw Error('ptz_stop_unconfirmed');
            braking = false;
            waitForTarget(ack.holdMs);
            schedule(0);
          } catch (error) {
            if (!current() || epoch!==displayEpoch) return;
            if (error instanceof Error && error.message==='ptz_busy' && performance.now()<retryUntil) {
              this.timer = setTimeout(() => { void send(); }, 75);
            } else end(ptzError(error));
          }
        };
        void send();
      };
      // Check the actual displayed frame even while followStep is awaiting I/O.
      // Brake immediately, and fence a delayed motion request with the old epoch.
      const checkDisplay = () => {
        if (!active || !current() || forgetting) return;
        if (document.hidden) { void this.stop(); return; }
        if (gapUntil && performance.now() >= gapUntil) { interrupt(true); return; }
        const tracks = this.read();
        const prefix = active.slice(0,active.lastIndexOf(':')+1);
        if (tracks.some(d => d.track_id && d.track_id.slice(0,d.track_id.lastIndexOf(':')+1) !== prefix)) {
          interrupt(true); return;
        }
        const matches = tracks.filter(d => d.track_id === active && !d.predicted && !d.lowConfidence);
        if (matches.length > 1) { interrupt(true); return; }
        if (matches.length) {
          if (held) schedule(0);
          return;
        }
        if (active !== this.state.selectedId) { lost(); return; }
        interrupt();
      };
      const watch = () => {
        this.animation = undefined;
        if (!current()) return;
        try { checkDisplay(); }
        catch (error) { end(ptzError(error)); }
        if (current()) this.animation = requestAnimationFrame(watch);
      };
      const tick = async () => {
        if (!current() || this.busy || braking) return;
        this.busy = true;
        const wantedAtStart = this.state.selectedId;
        const sent = wantedAtStart && (wantedAtStart === active || this.candidates.has(wantedAtStart))
          ? wantedAtStart : null;
        let delay = 200;
        const started = performance.now();
        const epoch = displayEpoch;
        try {
          if (document.hidden) { void this.stop(); return; }
          checkDisplay();
          if (!current() || braking || (held && active && !this.visible(active))) return;
          if (sent) {
            if (!this.visible(sent)) { lost(); return; }
            active = sent;
            held = false;
            if (!gapUntil) clearTimeout(this.expiry);
            if (this.animation === undefined) this.animation = requestAnimationFrame(watch);
          }
          const reply = epoch
            ? await ptzService.followStep(camera, sessionId, sent ?? undefined, false, epoch)
            : await ptzService.followStep(camera, sessionId, sent ?? undefined);
          if (!current()) return;
          if (epoch!==displayEpoch) return;
          if (reply.reselect && reply.displayEpoch !== undefined) { chooseAgain(reply.displayEpoch); delay=0; return; }
          checkDisplay();
          if (!current() || epoch !== displayEpoch) return;
          const {choices,waiting:serverWaiting} = reply;
          const tracks = this.read();
          const visible = uniqueIds(tracks.filter(d => !d.predicted && !d.lowConfidence).map(d => d.track_id));
          this.candidates = uniqueIds(choices.filter(c => visible.has(c.id)).map(c => c.id));
          if (automatic && !this.state.selectedId) {
            const id = largestPatrolTarget(automatic.label, tracks, this.candidates);
            if (id) {
              this.update({ ...this.state, selectedId: id, statusText: '正在确认巡航目标…' });
              delay = 0;
            }
            return;
          }
          const wanted = this.state.selectedId;
          let statusText = this.state.statusText;
          let selectedId = wanted;
          if (wanted && wanted === active && (serverWaiting || !this.candidates.has(wanted))) {
            // A repeated pre-gap frame can still list the target while parked.
            waitForTarget(reply.holdMs);
            delay = 100;
            return;
          }
          if (wanted && this.candidates.has(wanted)) {
            if (sent === wanted) {
              clearTimeout(this.expiry);
              gapUntil = 0;
              statusText = '跟踪中 · #' + wanted.split(':').at(-1);
              // Start-to-start cadence. Slow requests skip missed slots.
              delay = Math.max(0, trackingPeriodMs - (performance.now() - started));
            } else delay = 0;
          } else if (wanted && active) {
            lost(); return;
          } else if (wanted) {
            selectedId = null;
            statusText = reselect;
          } else if (!wanted && statusText !== reselect) {
            statusText = this.candidates.size ? '点击画面中的目标开始跟踪。' : '等待可选择的目标…';
          }
          this.update({ selectedId, pickReady: this.candidates.size > 0, ownsLease: true, statusText });
        } catch (error) {
          if (!current() || epoch!==displayEpoch) return;
          if (error instanceof Error && error.message==='ptz_busy' && sent) {
            if (!gapUntil) interrupt();
            delay=100;
            return;
          }
          const timeout = !sent && error instanceof Error &&
            ['ptz_follow_ended', 'ptz_session_expired'].includes(error.message);
          end(timeout ? expired : ptzError(error), timeout);
        } finally {
          if (current()) {
            this.busy = false;
            schedule(delay);
          }
        }
      };
      this.poll = tick;
      await tick();
    } catch (error) {
      end(ptzError(error));
    }
  }
}

export function usePtzFollow({ enabled, camera, processor, identity, displayedTracks, automatic }: Options) {
  const tracks = useRef(displayedTracks);
  useLayoutEffect(() => { tracks.current = displayedTracks; }, [displayedTracks]);
  const [control] = useState(() => new FollowControl(() => tracks.current?.current?.() ?? []));
  const [state, setState] = useState(idle);
  useLayoutEffect(() => {
    control.publish = setState;
    control.source = enabled && camera && processor && identity ? {camera, processor, identity, automatic} : undefined;
    void control.prepare();
    const leave = () => { void control.stop(); };
    const hidden = () => { if (document.hidden) leave(); };
    window.addEventListener('blur', leave);
    window.addEventListener('pagehide', leave);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      control.publish = undefined;
      control.source = undefined;
      window.removeEventListener('blur', leave);
      window.removeEventListener('pagehide', leave);
      document.removeEventListener('visibilitychange', hidden);
      leave();
    };
  }, [camera, processor, identity, enabled, control, automatic]);
  return { ...state, pick: control.pick, stop: control.stop };
}

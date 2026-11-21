import type { ReadDisplayedTracks, TrackPicking } from './AiDetectionOverlay';
import { createPortal } from 'react-dom';
import { usePtzFollow } from './usePtzFollow';
import { alarmTriggerService } from '@/api/alarmTriggerService';
import { labelDisplay } from '@/features/labelNames';
import { patrolLabelGroups, type PatrolLabel } from './ptzPatrol';
import { minPatrolSpeed, maxPatrolSpeed, preferredPatrolSpeed, rememberPatrolSpeed } from './horizontalPatrol';
import { usePtzPatrol } from './usePtzPatrol';
import { usePtzModeZoom } from './usePtzModeZoom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PtzAimSurface } from './PtzAimSurface';
import { X, Move, Minus, Plus, Square, MapPin, Save, Trash2, RefreshCw, Focus, ShieldCheck, Crosshair, ScanEye, Lightbulb, LightbulbOff, Droplets, Scan, ScanLine, ListRestart, Pencil, ChevronLeft, ChevronRight, Check, type LucideIcon } from 'lucide-react';
import { ptzService, ptzError, type PtzInfo, type PtzPreset } from '@/api/ptzService';

import { usePtzControl } from './usePtzControl';
const button =
  'flex min-h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-slate-100 hover:border-blue-400 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40';
const auxiliary: Record<string, [string, LucideIcon]> = {
  'tt:Wiper|On': ['开雨刷', Droplets], 'tt:Wiper|Off': ['关雨刷', Droplets],
  'tt:WashingProcedure|On': ['清洗', Droplets], 'tt:IRLamp|On': ['开红外灯', Lightbulb],
  'tt:IRLamp|Off': ['关红外灯', LightbulbOff], 'tt:Lamp|On': ['开灯', Lightbulb], 'tt:Lamp|Off': ['关灯', LightbulbOff],
};
function Tool({ label, icon: Icon, disabled, onClick }: {
  label: string; icon: LucideIcon; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className="ptz-tool" aria-label={label} title={label}
    disabled={disabled} onClick={onClick}><Icon size={16} aria-hidden="true"/><span>{label}</span></button>;
}
const directions = [
  [-1, 1, '↖', '左上'],
  [0, 1, '↑', '向上'],
  [1, 1, '↗', '右上'],
  [-1, 0, '←', '向左'],
  [0, 0, '■', '停止'],
  [1, 0, '→', '向右'],
  [-1, -1, '↙', '左下'],
  [0, -1, '↓', '向下'],
  [1, -1, '↘', '右下'],
] as const;
const keyDirections: Record<string, [number, number, number]> = {
  ArrowLeft: [-1, 0, 0],
  ArrowRight: [1, 0, 0],
  ArrowUp: [0, 1, 0],
  ArrowDown: [0, -1, 0],
  '+': [0, 0, 1],
  '=': [0, 0, 1],
  '-': [0, 0, -1],
};
type PtzMode = 'manual' | 'aim' | 'follow' | 'patrol';
interface Props {
  channelId: string;
  onClose: () => void;
  video?: HTMLVideoElement | null;
  isAiOutput?: boolean;
  followProcessor?: string;
  displayedTracks?: { current: ReadDisplayedTracks | null };
  onTrackPickingChange?: (picking: TrackPicking | null) => void;
  armingHost?: HTMLElement | null;
}
export function PtzPanel({ channelId, onClose, video, isAiOutput = false, followProcessor, displayedTracks, onTrackPickingChange, armingHost }: Props) {
  const [info, setInfo] = useState<PtzInfo>(),
    [presets, setPresets] = useState<PtzPreset[]>([]),
    [error, setError] = useState(''),
    [speed, setSpeed] = useState(0.35);
  const [name, setName] = useState(''),
    [shortcut, setShortcut] = useState(''),
    [editPreset, setEditPreset] = useState(''),
    [remove, setRemove] = useState<PtzPreset | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [overwrite, setOverwrite] = useState(false);
  const [mode, setMode] = useState<PtzMode>('manual');
  const [showPatrolHint, setShowPatrolHint] = useState(false);
  const [changingMode, setChangingMode] = useState(false);
  const modeIntent = useRef(0);
  const aim = mode === 'aim';
  const patrolling = mode === 'patrol';
  const [chosen, setChosen] = useState<PatrolLabel | null>(null);
  const [catalog, setCatalog] = useState<{processor: string; labels: PatrolLabel[]; failed: boolean}>();
  useEffect(() => {
    setCatalog(undefined);
    if (!patrolling || !followProcessor) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(processor: string) {
      try {
        const source = await alarmTriggerService.source(processor);
        if (source.channel_id !== processor) throw Error('channel mismatch');
        if (!disposed) setCatalog({processor, labels: source.labels, failed: false});
      } catch {
        if (!disposed) setCatalog({processor, labels: [], failed: true});
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(processor), 15000);
      }
    }
    void refresh(followProcessor);
    return () => { disposed = true; clearTimeout(timer); };
  }, [patrolling, followProcessor]);
  const currentCatalog = catalog?.processor === followProcessor ? catalog : undefined;
  const groups = useMemo(() => patrolLabelGroups(currentCatalog?.labels ?? []), [currentCatalog]);
  const patrolLabel = chosen && currentCatalog?.labels.find(label =>
    label.label_id === chosen.label_id && label.name === chosen.name);
  const missingSelection = !!chosen && !patrolLabel;
  const [patrolSpeed, setPatrolSpeed] = useState(0.2);
  const [routeType,setRouteType] = useState<'range'|'circle'>('range');
  const [filter, setFilter] = useState('');
  const [presetError, setPresetError] = useState('');
  const [tourStep, setTourStep] = useState('');
  const tour = useRef<AbortController | null>(null);
  const cancelTour = useCallback(() => {
    tour.current?.abort();
    tour.current = null;
    setTourStep('');
  }, []);
  useEffect(() => {
    const hidden = () => { if (document.hidden) cancelTour(); };
    window.addEventListener('blur', cancelTour);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelTour();
      window.removeEventListener('blur', cancelTour);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [channelId, info?.identity, cancelTour]);
  const [editing, setEditing] = useState(false);
  const [page, setPage] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const presetListVersion = useRef(0);
  const emergency = useRef<Promise<void> | null>(null);
  const panel = useRef<HTMLElement>(null),
    keys = useRef(new Set<string>()),
    lastFocus = useRef<HTMLElement | null>(null),
    refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const latest = await ptzService.inspect(channelId);
      if (version !== refreshVersion.current) return;
      setInfo(latest);
      setError('');
    } catch (e) {
      if (version === refreshVersion.current) setError(ptzError(e));
    }
  }, [channelId]);
  const queueRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void refresh();
    }, 700);
  }, [refresh]);
  const control = usePtzControl(channelId, info?.identity, queueRefresh);
  const loadPresets = useCallback(async () => {
    const version = ++presetListVersion.current;
    try {
      const r = await ptzService.presets(channelId);
      if (version !== presetListVersion.current) return;
      setPresets(r.items);
      setPresetError(r.reason ? ptzError(Error(r.reason)) : '');
    } catch (e) {
      if (version === presetListVersion.current) setPresetError(ptzError(e));
    }
  }, [channelId]);
  useEffect(() => {
    void refresh();
    lastFocus.current = document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => {
      clearTimeout(refreshTimer.current);
      ++refreshVersion.current;
      lastFocus.current?.focus();
    };
  }, [refresh]);
  useEffect(() => {
    if (info?.capabilities?.presets) void loadPresets();
  }, [info?.capabilities?.presets, loadPresets]);
  const caps = info?.capabilities;
  const follow = usePtzFollow({
    camera: channelId, processor: followProcessor, identity: info?.identity,
    enabled: mode === 'follow' && !!video && !!caps?.panTilt && info?.enabled !== false,
    displayedTracks,
  });
  const canAim = !!video && !!(caps?.pointCenter || caps?.panTilt);
  const showCalibration = aim && !!video && !!caps?.panTilt && !caps.pointCenter;
  const { calibration, refreshCalibration } = control;
  const [calibrationVideo, setCalibrationVideo] = useState<{ video: HTMLVideoElement } | null>(null);
  const calibrationVideoReady = !!video && calibrationVideo?.video === video;
  const calibrationRefreshPending = useRef(false);
  useEffect(() => {
    if (!showCalibration || !video || !info?.identity) {
      setCalibrationVideo(null);
      return;
    }
    let lastGeometry = '';
    let lastStream: HTMLVideoElement['srcObject'] = null;
    const checkVideo = () => {
      const ready = video.readyState >= 2 && !video.paused && !video.ended &&
        video.videoWidth > 0 && video.videoHeight > 0;
      if (!ready) { lastGeometry = ''; setCalibrationVideo(null); return; }
      const geometry = `${video.currentSrc}|${video.videoWidth}x${video.videoHeight}`;
      if (geometry === lastGeometry && video.srcObject === lastStream) return;
      lastGeometry = geometry;
      lastStream = video.srcObject;
      calibrationRefreshPending.current = true;
      setCalibrationVideo({video});
    };
    const events = ['loadeddata', 'playing', 'resize', 'pause', 'ended', 'emptied'];
    checkVideo();
    events.forEach(event => video.addEventListener(event, checkVideo));
    return () => events.forEach(event => video.removeEventListener(event, checkVideo));
  }, [showCalibration, video, channelId, info?.identity]);
  const canFollow = isAiOutput && !!followProcessor && !!video && !!caps?.panTilt && !!onTrackPickingChange;
  const patrolTargetUnavailable = isAiOutput && !!chosen && (!canFollow || missingSelection);
  const gbPatrolHint = '水平巡航目前仅支持可回报云台位置的 ONVIF 通道。';
  const gbChannel = info?.protocol === 'gb28181';
  const canPatrol = info?.protocol === 'onvif' && !!video && !!caps?.panTilt && caps.position === true;
  const patrol = usePtzPatrol({camera: channelId, processor: canFollow ? followProcessor : undefined,
    identity: info?.identity, enabled: patrolling && canPatrol && info?.enabled !== false && !info?.stopUnconfirmed,
    positionAvailable: caps?.position === true, video, displayedTracks, control});
  useEffect(() => {
    if (patrol.active && chosen && currentCatalog && !currentCatalog.failed && missingSelection) void patrol.stop();
  }, [patrol.active, patrol.stop, chosen, currentCatalog, missingSelection]);
  const labelPatrol = isAiOutput && canPatrol;
  useEffect(() => { setPatrolSpeed(preferredPatrolSpeed(info?.identity)); setRouteType('range'); }, [channelId,info?.identity]);
  const enabled = !!info?.supported && info.enabled !== false && !changingMode && !calibration.running &&
    !busy && !tourStep && (!info.busy || control.moving || control.preparing || follow.ownsLease || patrol.ownsLease);
  const screenReady = enabled && !patrol.active && control.state === 'idle' && !info?.stopUnconfirmed;
  const zoomDisabled = !enabled || !caps?.zoom || !!info?.stopUnconfirmed;
  const modeZoom = usePtzModeZoom({ mode: patrolling ? 'manual' : mode, channelId, identity: info?.identity, protocol: info?.protocol,
    permitted: !!info?.supported && info.enabled !== false && !!caps?.zoom && !info.stopUnconfirmed,
    speed, follow, control, disabled: zoomDisabled });
  useEffect(() => {
    if (!showCalibration || calibrationVideo?.video !== video || !video || !calibrationRefreshPending.current ||
        modeZoom.busy || control.state !== 'idle' || calibration.running || info?.stopUnconfirmed) return;
    calibrationRefreshPending.current = false;
    void refreshCalibration(video);
  }, [showCalibration, calibrationVideo, video, modeZoom.busy, control.state, calibration.running,
    info?.stopUnconfirmed, refreshCalibration]);
  const zoomButton = (direction: 1 | -1) => {
    if (showCalibration) calibrationRefreshPending.current = true;
    void modeZoom.step(direction);
  };
  const hadFollowLease = useRef(false);
  useEffect(() => {
    if (hadFollowLease.current && !follow.ownsLease) queueRefresh();
    hadFollowLease.current = follow.ownsLease;
  }, [follow.ownsLease, queueRefresh]);
  const presetReady = !modeZoom.busy && (screenReady || (aim && enabled && !info?.stopUnconfirmed));
  const changeMode = async (next: PtzMode) => {
    const intent = ++modeIntent.current;
    keys.current.clear();
    cancelTour();
    setNotice('');
    setChangingMode(true);
    try {
      if (!(await modeZoom.cancel())) return false;
      if (mode === 'follow' && !(await follow.stop())) return false;
      if (mode === 'patrol' && !(await patrol.stop())) return false;
      if (!(await control.stopConfirmed())) return false;
      if (modeIntent.current !== intent) return false;
      control.clearFeedback();
      setMode(next);
      if (info?.busy) void refresh();
      return true;
    } finally {
      if (modeIntent.current === intent) setChangingMode(false);
    }
  };
  useEffect(() => () => { ++modeIntent.current; }, []);
  useEffect(() => {
    if ((mode === 'follow' && !canFollow) || (mode === 'aim' && !canAim) || (patrolling && !canPatrol)) setMode('manual');
  }, [mode, canFollow, canAim, patrolling, canPatrol]);
  useEffect(() => {
    if (mode === 'follow' && canFollow && !changingMode && !modeZoom.busy && (follow.pickReady || follow.selectedId)) {
      onTrackPickingChange?.({ selectedId: follow.selectedId, pickEnabled: follow.pickReady, onPick: follow.pick });
      return () => onTrackPickingChange?.(null);
    }
  }, [mode, canFollow, changingMode, modeZoom.busy, follow.pickReady, follow.selectedId, follow.pick, onTrackPickingChange]);
  useEffect(() => {
    if (!patrolling || !patrol.selectedId) return;
    onTrackPickingChange?.({selectedId: patrol.selectedId, pickEnabled: false, onPick: () => {}});
    return () => onTrackPickingChange?.(null);
  }, [patrolling, patrol.selectedId, onTrackPickingChange]);
  const wasPatrolling = useRef(false);
  useEffect(() => {
    if (wasPatrolling.current && !patrol.active) queueRefresh();
    wasPatrolling.current = patrol.active;
  }, [patrol.active, queueRefresh]);

  // Calling a stored position ends any active image-directed movement first.
  const gotoPreset = async (id: string) => {
    setNotice('');
    if (mode === 'manual' || await changeMode('manual')) {
      control.begin({ pan: 0, tilt: 0, zoom: 0 }, id);
    }
  };
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !busy && !control.preparing) void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, busy, control.preparing]);
  const shortcuts = presets.filter(p => p.shortcut && p.available !== false && p.deviceState !== 'unconfirmed')
    .sort((a,b) => Number(a.shortcut) - Number(b.shortcut));
  const matches = presets.filter(p => (p.name + ' ' + p.id).includes(filter.trim()))
    .sort((a,b) => (a.shortcut ?? 10) - (b.shortcut ?? 10) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const presetGrid = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState(4);
  useEffect(() => {
    const grid = presetGrid.current;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const row = Number.parseFloat(getComputedStyle(grid).gridAutoRows) || 32;
      const gap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
      setPageSize(Math.max(1, Math.floor((grid.clientHeight + gap) / (row + gap))) * 2);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    measure();
    return () => observer.disconnect();
  }, [caps?.presets, editing, overwrite, remove]);
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const savedIndex = savedId ? matches.findIndex(p => p.id === savedId) : -1;
  const currentPage = savedIndex >= 0 ? Math.floor(savedIndex / pageSize) : Math.min(page, pages - 1);
  const changePage = (next: number) => { setSavedId(null); setPage(next); };
  const selectedPreset = presets.find(p => p.id === editPreset);
  const metadataChanged = !!selectedPreset && (name.trim() !== selectedPreset.name ||
    (shortcut ? Number(shortcut) : null) !== (selectedPreset.shortcut ?? null));
  const finishEditing = () => {
    setEditing(false);
    setEditPreset('');
    setName('');
    setShortcut('');
  };
  const startTour = async () => {
    if (tour.current || shortcuts.length < 2 || presetError || !caps?.moveStatus) return;
    if (mode !== 'manual' && !(await changeMode('manual'))) return;
    const run = new AbortController();
    tour.current = run;
    try {
      for (const [i, point] of shortcuts.entries()) {
        if (run.signal.aborted) return;
        setTourStep('巡看 ' + (i + 1) + '/' + shortcuts.length + ' · ' + point.name);
        const arrived = await new Promise<boolean>(done => control.begin({ pan: 0, tilt: 0, zoom: 0 }, point.id, done));
        if (run.signal.aborted) return;
        if (!arrived) { setNotice('巡看中止，设备未确认停稳'); return; }
        if (i + 1 < shortcuts.length) await new Promise<void>(done => {
          const timer = window.setTimeout(finish, 3000);
          function finish() { clearTimeout(timer); run.signal.removeEventListener('abort', finish); done(); }
          run.signal.addEventListener('abort', finish, { once: true });
        });
      }
      setNotice('本次巡看完成');
    } finally {
      if (tour.current === run) cancelTour();
    }
  };
  function showSaved(id: string, savedName: string, message: string) {
    finishEditing();
    setFilter('');
    setPage(0);
    setSavedId(id);
    setNotice(message + ' · ' + savedName + '（' + id + '）');
  }
  async function saveMetadata() {
    if (!selectedPreset || !metadataChanged || busy || !name.trim()) return;
    setBusy(true);
    setNotice('');
    try {
      const saved = await ptzService.updatePreset(channelId, selectedPreset.id, {
        name: name.trim(), shortcut: shortcut ? Number(shortcut) : null,
      });
      ++presetListVersion.current;
      setPresets(items => items.map(p => p.id === saved.id ? {...p, ...saved} : p));
      showSaved(saved.id, saved.name, '预置点资料已保存');
    } catch (e) {
      setNotice(ptzError(e));
    } finally {
      setBusy(false);
    }
  }
  const saveCurrent = () =>
    action(async () => {
      if (!(await control.stopConfirmed())) throw Error('ptz_stop_unconfirmed');
      const saved = await ptzService.save(channelId, {
        ...(editPreset ? { id: editPreset } : {}),
        name: name.trim(),
        shortcut: shortcut ? Number(shortcut) : null,
      });
      showSaved(saved.id, name.trim(), '预置点已保存');
    });
  const closing = useRef(false);
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    cancelTour();
    keys.current.clear();
    ++modeIntent.current;
    setChangingMode(true);
    try {
      const stopped = await Promise.all([modeZoom.cancel(), control.stopConfirmed(true), follow.stop(), patrol.stop()]);
      if (!stopped.every(Boolean)) throw Error('ptz_stop_unconfirmed');
      onClose();
    } catch {
      setNotice('停止尚未确认，再次关闭可重试停转。');
    } finally {
      closing.current = false;
      setChangingMode(false);
    }
  };
  const held = (pan: number, tilt: number, zoom = 0) => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || e.isPrimary === false) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      control.begin({ pan: pan * speed, tilt: tilt * speed, zoom: zoom * speed });
    },
    onPointerUp: () => {
      void control.stop();
    },
    onPointerCancel: () => {
      void control.stop();
    },
    onLostPointerCapture: () => {
      void control.stop();
    },
  });
  const keyVector = () => {
    const v = { pan: 0, tilt: 0, zoom: 0 };
    for (const key of keys.current) {
      const d = keyDirections[key];
      if (d) {
        v.pan += d[0];
        v.tilt += d[1];
        v.zoom += d[2];
      }
    }
    return {
      pan: Math.sign(v.pan) * speed,
      tilt: Math.sign(v.tilt) * speed,
      zoom: Math.sign(v.zoom) * speed,
    };
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice('');
    try {
      if ((mode === 'follow' || patrolling) && !(await changeMode('manual'))) return;
      await fn();
      await refresh();
      await loadPresets();
    } catch (e) {
      setNotice(ptzError(e));
    } finally {
      setBusy(false);
    }
  };
  const emergencyStop = () => {
    cancelTour();
    if (emergency.current) return;
    ++modeIntent.current;
    setChangingMode(false);
    void modeZoom.cancel();
    void follow.stop();
    void patrol.stop();
    emergency.current = control.priorityStop()
      .then(() => setNotice('已请求停转'))
      .catch((e) => setNotice(ptzError(e)))
      .then(queueRefresh)
      .finally(() => {
        emergency.current = null;
      });
  };
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="摄像头云台控制"
      className="ptz-panel pointer-events-auto z-50 min-h-0  border-l border-slate-700 bg-slate-900 p-2 text-slate-100 outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (keys.current.size && !e.currentTarget.contains(e.relatedTarget as Node)) {
          keys.current.clear();
          void control.stop();
        }
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (
          overwrite ||
          remove ||
          (e.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]')
        )
          return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          void close();
          return;
        }
        if (e.key === ' ' && !(e.target as HTMLElement).closest('button')) {
          e.preventDefault();
          emergencyStop();
          return;
        }
        if (
          /^[1-9]$/.test(e.key) &&
          presetReady && !editing &&
          caps?.presets &&
          !control.moving &&
          !control.preparing
        ) {
          const p = presets.find((p) => p.shortcut === Number(e.key) && p.available !== false);
          if (p) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) void gotoPreset(p.id);
          }
          return;
        }
        const d = keyDirections[e.key];
        if (mode !== 'manual' || !d || !enabled || (d[2] && !caps?.zoom) || ((d[0] || d[1]) && !caps?.panTilt)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        keys.current.add(e.key);
        control.begin(keyVector());
      }}
      onKeyUp={(e) => {
        if (!keys.current.delete(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const v = keyVector();
        if (v.pan || v.tilt || v.zoom) control.begin(v);
        else void control.stop();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1 text-xs font-semibold"><Move size={14}/>云台</h3>
        <div className="flex items-center gap-1">
          <button className={button} title="关闭云台控制" aria-label="关闭云台控制" onClick={() => void close()}><X size={14}/></button>
        </div>
      </div>
      <div className="ptz-modes" role="group" aria-label="云台控制模式">
        {([
          ['manual', '手动控制', Move, true, '用方向键控制云台'],
          ['aim', '点击居中', Crosshair, canAim, !video ? '等待可用的视频画面' : canAim ? (caps?.pointCenter ? '使用摄像头原生定位，滚轮变焦' : '使用当前倍率标定定位，滚轮变焦') : '设备不支持转动'],
          ['follow', 'AI 跟踪', ScanEye, canFollow, !isAiOutput ? '仅 AI 输出通道可用' : canFollow ? '点选画面中的识别框' : '等待可跟踪的实时画面'],
          ['patrol', '巡航', ScanLine, canPatrol, !caps?.position ? '此通道无法回读云台位置，自动巡航不可用' : canPatrol ? '沿当前高度水平巡航' : '等待实时画面'],
        ] as const).map(([value, label, Icon, available, hint]) => value === 'patrol' && gbChannel ? (
          <button key={value} type="button" aria-label={label} aria-description={gbPatrolHint} title={gbPatrolHint}
            style={{color: '#94a3b8'}} onClick={() => setShowPatrolHint(true)} onBlur={() => setShowPatrolHint(false)}>
            <Icon size={15} aria-hidden="true"/>{label}
          </button>
        ) : (
          <button key={value} type="button" aria-pressed={mode === value} aria-label={label} title={hint}
            disabled={changingMode || calibration.running || (!available && mode !== value) ||
              (value !== 'manual' && mode !== value && (!info?.supported || info.enabled === false || info.stopUnconfirmed))}
            onClick={() => { if (value !== mode) void changeMode(value); }}>
            <Icon size={15} aria-hidden="true"/>{label}
          </button>
        ))}
      </div>
      {gbChannel && showPatrolHint && <p role="status" className="my-1 text-xs text-slate-300">{gbPatrolHint}</p>}
      {!patrolling && (!showCalibration || !!info?.stopUnconfirmed || (!!info?.busy && !control.moving && !control.preparing && control.state === 'idle')) &&
      <p role="status" data-idle={mode === 'manual' && control.state === 'idle' && info?.supported && !info?.busy && info.enabled !== false && !info.stopUnconfirmed} className="my-1 text-xs leading-4 text-slate-300">
        {modeZoom.busy ? '正在调节镜头…' : control.state === 'preparing'
          ? '正在准备控制…'
          : control.state === 'moving'
            ? (aim ? '云台移动中' : '正在移动 · 松开停止')
            : control.state === 'preset'
              ? '正在定位 · 可随时停转'
              : control.state === 'stopping'
                ? '正在停止…'
                : info?.stopUnconfirmed
                  ? '停止尚未确认'
                  : info?.busy && !follow.ownsLease
                    ? '其他窗口正在控制'
                    : info?.enabled === false
                      ? '云台控制已关闭'
                      : info?.supported
                        ? mode === 'follow' ? (follow.statusText || '点选识别框开始跟踪') : aim ? (caps?.zoom ? '点画面任意位置居中 · 滚轮变焦' : '点画面任意位置居中') : '按住转动，松开停止'
                        : '能力尚未确认或不支持'}
      </p>}
      {caps?.reason && (
        <p className="mb-3 rounded-lg bg-amber-950/40 p-2 text-xs leading-5 text-amber-200">
          {ptzError(Error(caps.reason))}
        </p>
      )}
      {(error || control.error) && (
        <p role="alert" className="mb-3 rounded-lg bg-red-950 p-2 text-xs leading-5 text-red-200">
          {error || control.error}
        </p>
      )}
      {showCalibration && video && (
        <section aria-label="点击居中标定" className="ptz-calibration-row">
            <button type="button" className={button + ' whitespace-nowrap px-2 text-xs'}
              title="标定会向四个方向短动，可随时停止"
              disabled={!calibration.running && (!calibrationVideoReady || !screenReady || modeZoom.busy)}
              onClick={() => {
                if (calibration.running) void control.stop();
                else void control.calibrate(video);
              }}>{calibration.running ? '停止标定' : calibration.ready ? '重新标定' : '开始标定'}</button>
          <span role="status" title={calibration.message}>
            {calibration.running ? `标定中 ${calibration.progress}/${calibration.total}`
              : !calibrationVideoReady ? '等待视频就绪'
              : calibration.ready === 4 ? (caps?.zoom ? '已标定 · 滚轮变焦' : '已标定 · 点击定位')
              : (calibration.message && !calibration.message.startsWith('请先完成') && calibration.message !== '尚未读取标定'
                ? calibration.message : `已标定 ${calibration.ready}/4 方向`)}
          </span>
        </section>
      )}
      {patrolling && (
        <section aria-label="巡航设置" className="ptz-section ptz-patrol">
          {labelPatrol && <label>目标标签
            <select disabled={patrol.active} value={missingSelection ? '$unavailable' : chosen?.label_id ?? ''}
              onChange={e => setChosen(currentCatalog?.labels.find(l => l.label_id === e.target.value) ?? null)}>
              <option value="">仅扫描（不跟踪）</option>
              {missingSelection && <option value="$unavailable" disabled>{labelDisplay(chosen.name)} · 待核验</option>}
              {groups.map(group => <optgroup key={group.title} label={group.title}>
                {group.items.map(l => <option key={l.label_id} value={l.label_id}>
                  {labelDisplay(l.name)}{currentCatalog!.labels.some(other => other.label_id !== l.label_id &&
                    labelDisplay(other.name) === labelDisplay(l.name)) ? ' · ' + l.label_id : ''}
                </option>)}
              </optgroup>)}
            </select>
            {(!followProcessor || !currentCatalog || currentCatalog.failed) &&
              <small role="status">{!followProcessor ? '等待实时画面' : currentCatalog?.failed ? '标签暂不可用，将自动重试' : '正在读取通道标签…'}</small>}
          </label>}
          <label className="ptz-patrol-speed">扫描速度 <input type="range" min={minPatrolSpeed} max={maxPatrolSpeed} step="0.05"
            disabled={patrol.active} value={patrolSpeed}
            onChange={event => {
              const value = Number(event.target.value);
              setPatrolSpeed(value);
              if (info?.identity) rememberPatrolSpeed(info.identity,value);
            }}/>
            <span>{Math.round(patrolSpeed * 100)}%</span></label>
          {patrol.route && !patrol.teaching && <button type="button" className={button}
            disabled={!patrol.active && (!screenReady || patrol.ownsLease || (labelPatrol && patrolTargetUnavailable))}
            onClick={() => { if(patrol.active) void patrol.stop(); else patrol.start(patrolSpeed,labelPatrol ? patrolLabel ?? null : null); }}>
            {patrol.active ? '停止巡航' : '开始巡航'}</button>}
          <p role="status" className="m-0 text-slate-300">{info?.stopUnconfirmed ? '停止尚未确认' :
            patrol.status || (info?.busy && !patrol.active ? '其他窗口正在控制' :
              patrol.route ? '沿当前高度水平扫描' :
              '先对准扫描起点，再设置范围')}</p>
          <details key={patrol.route ? 'configured' : 'unconfigured'} open={patrol.teaching || !patrol.route ? true : undefined}>
            <summary className="cursor-pointer" onClick={event => { if (patrol.teaching) event.preventDefault(); }}>设置范围</summary>
            <div className="ptz-patrol-options">
              <label>路线 <select disabled={patrol.active} value={routeType}
                onChange={event => setRouteType(event.target.value === 'circle' ? 'circle' : 'range')}>
                <option value="range">左右端点往返</option>
                <option value="circle">整圈往返</option>
              </select></label>
              {!patrol.teaching && <button type="button" className={button} disabled={!screenReady}
                onClick={() => patrol.teach(patrolSpeed,routeType==='circle')}>记下起点并向右低速试扫</button>}
              {patrol.teaching && <div className="flex gap-1">
                {patrol.confirmRequired && <button type="button" className={button+' flex-1'} disabled={!patrol.canFinish}
                  onClick={patrol.confirmEnd}>{routeType==='circle' ? '已回到起点' : '记下右端'}</button>}
                <button type="button" className={button} onClick={()=>void patrol.stop()}>取消</button>
              </div>}
            </div>
          </details>
        </section>
      )}
      {(aim || mode === 'follow') && <div role="group" aria-label="镜头控制" className="ptz-lens-actions flex gap-1">
        {caps?.zoom && <button type="button" className={button + ' min-w-0 flex-1 flex-col gap-0 px-0 text-xs'}
          disabled={zoomDisabled || modeZoom.busy} onClick={() => zoomButton(-1)}>
          <Minus size={15} aria-hidden="true"/>拉远
        </button>}
        <button type="button" aria-label="停止云台转动" className={button + ' min-w-0 flex-1 flex-col gap-0 px-0 text-xs'} onClick={emergencyStop}>
          <Square size={14} aria-hidden="true"/>停止
        </button>
        {caps?.zoom && <button type="button" className={button + ' min-w-0 flex-1 flex-col gap-0 px-0 text-xs'}
          disabled={zoomDisabled || modeZoom.busy} onClick={() => zoomButton(1)}>
          <Plus size={15} aria-hidden="true"/>拉近
        </button>}
      </div>}
      {mode === 'manual' && <div className="ptz-motion">
      {caps?.panTilt && (
        <div className="ptz-pad" aria-label="转动摄像头">
          {directions.map(([pan, tilt, symbol, label]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              disabled={(!enabled || control.state === 'preset') && label !== '停止'}
              className={button + ' aspect-square touch-none px-0 text-base select-none'}
              {...(label === '停止' ? { onClick: emergencyStop, title: '停止云台转动' } : held(pan, tilt))}
            >
              {label === '停止' ? <Square size={17} /> : symbol}
            </button>
          ))}
        </div>
      )}
      {caps?.zoom && (
        <div className="ptz-zoom">
          <button
            className={button + ' touch-none select-none whitespace-nowrap px-1'}
            disabled={!enabled || control.state === 'preset'}
            {...held(0, 0, -1)}
          >
            <Minus size={16} />
            拉远
          </button>
          <button
            className={button + ' touch-none select-none whitespace-nowrap px-1'}
            disabled={!enabled || control.state === 'preset'}
            {...held(0, 0, 1)}
          >
            <Plus size={16} />
            拉近
          </button>
        </div>
      )}
      </div>}
      {(aim ? caps?.zoom : mode === 'manual' && (caps?.panTilt || caps?.zoom)) && (
        <label className="flex items-center gap-2 text-xs">
          {aim ? '变焦速度' : '速度'}
          <input
            aria-label={aim ? '镜头变焦速度' : '云台速度'}
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="min-h-7 min-w-0 flex-1 accent-blue-400"
          />
          <span className="w-8 text-right text-slate-300">{Math.round(speed * 100)}%</span>
        </label>
      )}
      {aim && video && canAim && !calibration.running && (
        <PtzAimSurface video={video} onExit={() => void changeMode('manual')} onLeave={() => control.stopScreenGesture(true)}
          onPoint={(x, y) => { if (enabled && !info?.stopUnconfirmed && !modeZoom.busy) control.centerPoint(x, y, video, caps); }}
          onZoom={caps?.zoom ? direction => {
            if (info?.enabled !== false && !changingMode && !busy && !modeZoom.busy && !tourStep) {
              if (showCalibration) calibrationRefreshPending.current = true;
              void control.zoomStep(direction * speed);
            }
          } : undefined}
        />
      )}
      {tourStep && <button className={button + ' mt-2 w-full'} onClick={emergencyStop}>{tourStep} · 停止</button>}
      {(caps?.focus || caps?.autoFocus || !!caps?.auxiliary?.length) && (
        <section className="ptz-section" aria-label="镜头与辅助设备">
          {(caps?.focus || caps?.autoFocus) && <div className="ptz-tools">
            {([['near','调近焦',Scan], ['far','调远焦',ScanLine], ['auto','恢复自动对焦',Focus]] as const)
              .filter(([key]) => key === 'auto' ? caps.autoFocus : caps.focus)
              .map(([key,label,icon]) => <Tool key={key} label={label} icon={icon} disabled={!screenReady}
                onClick={() => void action(async () => { await ptzService.lens(channelId,key); setNotice('设备已接受' + label); })}/>)}
          </div>}
          <div className="ptz-tools">
            {caps?.auxiliary?.filter(key => auxiliary[key]).map(key => {
              const [label, icon] = auxiliary[key]!;
              return <Tool key={key} label={label} icon={icon} disabled={!screenReady}
                onClick={() => void action(async () => { await ptzService.lens(channelId,key); setNotice('设备已接受' + label); })}/>;
            })}
          </div>
        </section>
      )}
      {isAiOutput && info?.supported && info.enabled !== false && info.source?.id && followProcessor &&
        <PtzSceneStatus sourceId={info.source.id} processorId={followProcessor} disabled={!presetReady} onReturn={id=>void gotoPreset(id)}/>}
      {isAiOutput && armingHost && info?.guard?.blocked && createPortal(
        <details className="ptz-section text-xs text-amber-200">
          <summary className="cursor-pointer"><ShieldCheck size={14} className="mr-1 inline"/>布防待核对</summary>
          <p>转动已暂停关联告警与计数。请先核对视角或重新保存布防。</p>
          {!!info.guard.baseline && <button className={button} disabled={!screenReady}
            onClick={() => void action(() => ptzService.restore(channelId, Number(info.guard!.revision), 'position'))}>
            <ShieldCheck size={15}/>已回原视角，恢复</button>}
          <button className={button} disabled={!screenReady}
            onClick={() => void action(() => ptzService.restore(channelId, Number(info.guard!.revision), 'rearmed'))}>
            <Check size={15}/>已重新布防，恢复</button>
        </details>, armingHost
      )}
      {caps?.presets && (
        <section className="ptz-presets" aria-label="预置点操作">
          <header><MapPin size={14}/>预置点
            {!editing && !overwrite && !remove && (<div className="ptz-tools">
                <Tool label="刷新预置点" icon={RefreshCw} disabled={busy} onClick={() => void loadPresets()}/>
                {caps.presetWrite && <Tool label="管理预置点" icon={Pencil} onClick={() => { control.clearFeedback(); setEditing(true); }}/>}
                {caps.moveStatus && <Tool label="按快捷编号巡看一次" icon={ListRestart}
                  disabled={!screenReady || shortcuts.length < 2 || !!presetError} onClick={() => void startTour()}/>}
              </div>)}
          </header>
          {presetError && <p role="alert" className="text-xs text-amber-200">{presetError}</p>}
          {overwrite || remove ? (
            <div className="ptz-section text-xs" role="group" aria-label="核对预置点操作">
              <strong>{remove ? '删除预置点' : '覆盖预置点'}</strong>
              <p>{remove ? '将删除摄像头上的位置及快捷入口' : '将用当前镜头位置替换原位置'}「{remove?.name || selectedPreset?.name || editPreset}」（编号 {remove?.id ?? editPreset}）。</p>
              <button className={button} onClick={() => { setOverwrite(false); setRemove(null); }}>取消</button>
              <button className={button} disabled={!screenReady} onClick={() => {
                if (remove) {
                  const id = remove.id;
                  setRemove(null);
                  void action(async () => {
                    await ptzService.remove(channelId,id);
                    finishEditing(); setSavedId(null); setNotice('预置点已删除 · ' + (remove.name || id) + '（' + id + '）');
                  });
                } else { setOverwrite(false); void saveCurrent(); }
              }}>{remove ? '确认删除' : '确认覆盖'}</button>
            </div>
          ) : editing && caps.presetWrite ? (
            <>
              <label>保存到<select aria-label="保存到预置点" disabled={busy} value={editPreset} onChange={e => {
                setEditPreset(e.target.value);
                const point = presets.find(p => p.id === e.target.value);
                setName(point?.name ?? ''); setShortcut(point?.shortcut ? String(point.shortcut) : '');
              }}><option value="">新增预置点</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name ? p.name + '（' + p.id + '）' : p.id}</option>)}</select></label>
              <label>名称<input aria-label="预置点名称" disabled={busy} value={name} maxLength={100} onChange={e => setName(e.target.value)}/></label>
              <label>快捷编号<select aria-label="预置点快捷编号" disabled={busy} value={shortcut} onChange={e => setShortcut(e.target.value)}>
                <option value="">不设快捷编号</option>{Array.from({length:9}, (_,i) => <option key={i} value={i+1} disabled={presets.some(p => p.shortcut === i+1 && p.id !== editPreset)}>{i+1}</option>)}</select></label>
              <div className="ptz-tools">
                <Tool label="返回列表" icon={ChevronLeft} disabled={busy} onClick={finishEditing}/>
                {editPreset && <Tool label="保存名称和快捷编号" icon={Save}
                  disabled={busy || !metadataChanged || !name.trim()} onClick={() => void saveMetadata()}/>}
                <Tool label={editPreset ? '覆盖为当前位置' : '保存当前位置'} icon={editPreset ? MapPin : Save} disabled={!screenReady || !name.trim() || (!!editPreset && (!selectedPreset || metadataChanged))}
                  onClick={() => editPreset ? setOverwrite(true) : void saveCurrent()}/>
                {editPreset && <Tool label="删除此预置点" icon={Trash2} disabled={!screenReady}
                  onClick={() => setRemove(presets.find(p => p.id === editPreset) ?? null)}/>}
              </div>
            </>
          ) : (
            <>
              {(presets.length > 4 || !!filter) && <input aria-label="查找预置点" placeholder="名称或编号" value={filter}
                onChange={e => { setFilter(e.target.value); changePage(0); }}/>}
              <div className="ptz-preset-grid" ref={presetGrid}>
                {matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(p => <button key={p.id} className={button + ' min-w-0 justify-start px-1 text-xs'}
                  aria-current={p.id === savedId ? 'true' : undefined}
                  title={(p.name || '位置') + '（' + p.id + '）'} disabled={!presetReady || p.available === false}
                  onClick={() => void gotoPreset(p.id)}>
                  {p.shortcut && <span className="text-xs text-blue-300">{p.shortcut}</span>}
                  <span className="truncate">{p.name || '位置 ' + p.id}</span></button>)}
              </div>
              {!matches.length && !presetError && <p>{filter ? '没有匹配的位置' : '尚无预置点'}</p>}
              {pages > 1 && <div className="ptz-pages flex items-center justify-between">
                <Tool label="上一页" icon={ChevronLeft} disabled={!currentPage} onClick={() => changePage(currentPage - 1)}/>
                <span>{currentPage + 1} / {pages}</span>
                <Tool label="下一页" icon={ChevronRight} disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)}/>
              </div>}
            </>
          )}
        </section>
      )}
      {notice && <p role="status" className="mt-2 text-xs text-amber-200">{notice}</p>}
      {modeZoom.notice && <p role="status" className="text-xs text-amber-200">{modeZoom.notice}</p>}
      {control.notice && !(showCalibration && (calibrationVideoReady || calibration.running) && control.notice === calibration.message) && <p role="status" className="text-xs text-amber-200">{control.notice}</p>}
    </aside>
  );
}
import {PtzSceneStatus} from './PtzSceneStatus';

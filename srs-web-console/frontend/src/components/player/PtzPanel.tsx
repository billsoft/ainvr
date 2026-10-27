import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Move, Minus, Plus, Square, MapPin, Save, Trash2, RefreshCw } from 'lucide-react';
import { ptzService, ptzError, type PtzInfo, type PtzPreset } from '@/api/ptzService';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { usePtzControl } from './usePtzControl';
const button =
  'flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 text-sm text-slate-100 hover:border-blue-400 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400 disabled:cursor-not-allowed disabled:opacity-40';
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
export function PtzPanel({ channelId, onClose }: { channelId: string; onClose: () => void }) {
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
  const emergency = useRef<Promise<void> | null>(null);
  const panel = useRef<HTMLElement>(null),
    keys = useRef(new Set<string>()),
    lastFocus = useRef<HTMLElement | null>(null),
    refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      setInfo(await ptzService.inspect(channelId));
      setError('');
    } catch (e) {
      setError(ptzError(e));
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
    try {
      const r = await ptzService.presets(channelId);
      setPresets(r.items);
      if (r.reason) setNotice(ptzError(Error(r.reason)));
    } catch (e) {
      setNotice(ptzError(e));
    }
  }, [channelId]);
  useEffect(() => {
    void refresh();
    lastFocus.current = document.activeElement as HTMLElement;
    panel.current?.focus();
    return () => {
      clearTimeout(refreshTimer.current);
      lastFocus.current?.focus();
    };
  }, [refresh]);
  useEffect(() => {
    if (info?.capabilities?.presets) void loadPresets();
  }, [info?.capabilities?.presets, loadPresets]);
  const caps = info?.capabilities,
    enabled =
      !!info?.supported &&
      info.enabled !== false &&
      !busy &&
      (!info.busy || control.moving || control.preparing);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !busy && !control.preparing) void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, busy, control.preparing]);
  const saveCurrent = () =>
    action(async () => {
      await control.stop();
      await ptzService.save(channelId, {
        ...(editPreset ? { id: editPreset } : {}),
        name: name.trim(),
        shortcut: shortcut ? Number(shortcut) : null,
      });
      setName('');
      setShortcut('');
      setEditPreset('');
      setNotice('预置点已保存');
    });
  const close = async () => {
    keys.current.clear();
    await control.stop();
    onClose();
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
    if (emergency.current) return;
    // Cancel local intent immediately, but never await a slow acquisition before
    // sending the priority Stop through the independent service lane.
    const cancelled = control.stop();
    emergency.current = ptzService
      .stop(channelId, null)
      .then((result) => {
        if (!result.stopConfirmed) throw Error('ptz_stop_unconfirmed');
        setNotice('已请求停止摄像头；布防仍需核对恢复。');
      })
      .catch((e) => setNotice(ptzError(e)))
      .then(() => {
        void cancelled;
        queueRefresh();
      })
      .finally(() => {
        emergency.current = null;
      });
  };
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      aria-label="摄像头云台控制"
      className="ptz-panel pointer-events-auto z-50 min-h-0 overflow-y-auto border-l border-slate-700 bg-slate-900 p-3 text-slate-100 outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
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
        if (e.key === ' ') {
          e.preventDefault();
          keys.current.clear();
          void control.stop();
          return;
        }
        if (
          /^[1-9]$/.test(e.key) &&
          enabled &&
          caps?.presets &&
          !control.moving &&
          !control.preparing
        ) {
          const p = presets.find((p) => p.shortcut === Number(e.key) && p.available !== false);
          if (p) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) control.begin({ pan: 0, tilt: 0, zoom: 0 }, p.id);
          }
          return;
        }
        const d = keyDirections[e.key];
        if (!d || !enabled || (d[2] && !caps?.zoom) || ((d[0] || d[1]) && !caps?.panTilt)) return;
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
      <div className="sticky -top-3 -mx-3 -mt-3 z-10 flex items-start justify-between gap-2 border-b border-slate-700 bg-slate-900 p-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Move size={17} />
            云台控制
          </h3>
          <p className="mt-1 text-xs text-slate-300">
            {info?.source.name ?? '正在核对原始摄像头…'}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            className={button + ' border-amber-700 px-0 text-amber-200'}
            aria-label="紧急停止摄像头"
            title="停止摄像头"
            onClick={emergencyStop}
          >
            <Square size={18} />
          </button>
          <button
            className={button + ' shrink-0 px-0'}
            aria-label="关闭云台控制"
            onClick={() => void close()}
          >
            <X size={18} />
          </button>
        </div>
      </div>
      <p role="status" className="my-3 text-xs leading-5 text-slate-300">
        {control.state === 'preparing'
          ? '正在暂停布防并准备控制…'
          : control.state === 'moving'
            ? '正在移动 · 松开停止'
            : control.state === 'preset'
              ? '已发送预置位 · 请观察画面，可随时停止'
              : control.state === 'stopping'
                ? '正在停止…'
                : info?.stopUnconfirmed
                  ? '停止尚未确认'
                  : info?.busy
                    ? '其他窗口正在控制'
                    : info?.enabled === false
                      ? '云台控制已关闭'
                      : info?.supported
                        ? '按住移动，松开停止；准备时松开会取消'
                        : '能力尚未确认或不支持'}
      </p>
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
      {caps?.panTilt && (
        <div className="mx-auto grid w-44 grid-cols-3 gap-1.5" aria-label="转动摄像头">
          {directions.map(([pan, tilt, symbol, label]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              disabled={(!enabled || control.state === 'preset') && label !== '停止'}
              className={button + ' aspect-square touch-none px-0 text-xl select-none'}
              {...(label === '停止' ? { onClick: () => void control.stop() } : held(pan, tilt))}
            >
              {label === '停止' ? <Square size={17} /> : symbol}
            </button>
          ))}
        </div>
      )}
      {caps?.zoom && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            className={button + ' touch-none select-none'}
            disabled={!enabled || control.state === 'preset'}
            {...held(0, 0, -1)}
          >
            <Minus size={16} />
            拉远
          </button>
          <button
            className={button + ' touch-none select-none'}
            disabled={!enabled || control.state === 'preset'}
            {...held(0, 0, 1)}
          >
            <Plus size={16} />
            拉近
          </button>
        </div>
      )}
      {(caps?.panTilt || caps?.zoom) && (
        <label className="mt-3 flex items-center gap-2 text-xs">
          速度
          <input
            aria-label="云台速度"
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="min-h-11 min-w-0 flex-1 accent-blue-400"
          />
          <span className="w-8 text-right text-slate-300">{Math.round(speed * 100)}%</span>
        </label>
      )}
      <button
        className={button + ' mt-2 w-full border-amber-700 text-amber-200'}
        onClick={emergencyStop}
      >
        <Square size={15} />
        停止摄像头
      </button>
      {info?.guard?.blocked && (
        <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 p-2.5 text-xs leading-5 text-amber-200">
          <strong>原布防视角已暂停</strong>
          <p>录像和识别继续。停止转动后，请恢复原视角或重新保存关联 AI 输出的布防。</p>
          <div className="mt-2 grid gap-2">
            {!!info.guard.baseline && (
              <button
                className={button}
                disabled={busy || control.moving}
                onClick={() =>
                  void action(() =>
                    ptzService.restore(channelId, Number(info.guard!.revision), 'position'),
                  )
                }
              >
                已回到原视角，核对并恢复
              </button>
            )}
            <button
              className={button}
              disabled={busy || control.moving}
              onClick={() =>
                void action(() =>
                  ptzService.restore(channelId, Number(info.guard!.revision), 'rearmed'),
                )
              }
            >
              已重新保存布防，恢复运行
            </button>
          </div>
        </div>
      )}
      {caps?.presets && (
        <section className="mt-4 border-t border-slate-700 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="flex items-center gap-1.5 text-sm font-medium">
              <MapPin size={15} />
              预置点
            </h4>
            <button
              aria-label="刷新预置点"
              className={button + ' px-0'}
              disabled={busy}
              onClick={() => void loadPresets()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[...presets]
              .sort(
                (a, b) => (a.shortcut ?? 10) - (b.shortcut ?? 10) || a.name.localeCompare(b.name),
              )
              .map((p) => (
                <button
                  key={p.id}
                  className={button + ' min-w-0 justify-start px-2 text-left'}
                  title={p.name}
                  disabled={
                    !enabled || control.moving || control.preparing || p.available === false
                  }
                  onClick={() => control.begin({ pan: 0, tilt: 0, zoom: 0 }, p.id)}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-blue-950 text-xs text-blue-200">
                    {p.shortcut ?? '•'}
                  </span>
                  <span className="truncate">{p.name || `位置 ${p.id}`}</span>
                </button>
              ))}
          </div>
          {!presets.length && (
            <p className="text-xs leading-5 text-slate-400">
              尚无预置点。先调整镜头，再保存当前位置。
            </p>
          )}
          {caps.presetWrite && (
            <details className="mt-3 rounded-lg border border-slate-700 p-2">
              <summary className="min-h-11 cursor-pointer py-3 text-xs">保存／管理预置点</summary>
              <div className="space-y-2 pb-1">
                <label className="block text-xs">
                  保存到
                  <select
                    aria-label="保存到预置点"
                    className="mt-1 min-h-11 w-full rounded bg-slate-800 px-2"
                    value={editPreset}
                    onChange={(e) => {
                      setEditPreset(e.target.value);
                      const p = presets.find((p) => p.id === e.target.value);
                      setName(p?.name ?? '');
                      setShortcut(p?.shortcut ? String(p.shortcut) : '');
                    }}
                  >
                    <option value="">新增预置点</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs">
                  名称
                  <input
                    aria-label="预置点名称"
                    maxLength={100}
                    placeholder="例如：前门、后门"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="mt-1 min-h-11 w-full rounded border border-slate-600 bg-slate-800 px-2"
                  />
                </label>
                <label className="block text-xs">
                  快捷编号
                  <select
                    aria-label="预置点快捷编号"
                    value={shortcut}
                    onChange={(e) => setShortcut(e.target.value)}
                    className="mt-1 min-h-11 w-full rounded bg-slate-800 px-2"
                  >
                    <option value="">不设快捷编号</option>
                    {Array.from({ length: 9 }, (_, i) => (
                      <option key={i} value={i + 1}>
                        {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs leading-5 text-slate-400">
                  保存摄像头当前位置和镜头状态。名称与快捷编号保存在
                  AINVR；对焦沿用摄像头设置。选择已有位置将覆盖该预置位。
                </p>
                <button
                  className={button + ' w-full border-blue-600 bg-blue-700'}
                  disabled={busy || control.moving || control.preparing || !name.trim()}
                  onClick={() => (editPreset ? setOverwrite(true) : void saveCurrent())}
                >
                  <Save size={15} />
                  {editPreset ? '覆盖为当前位置' : '保存当前位置'}
                </button>
                {editPreset && (
                  <button
                    className={button + ' w-full text-red-300'}
                    disabled={busy || control.moving}
                    onClick={() => setRemove(presets.find((p) => p.id === editPreset) ?? null)}
                  >
                    <Trash2 size={15} />
                    删除此预置点
                  </button>
                )}
              </div>
            </details>
          )}
        </section>
      )}
      {!!caps && !caps.position && (
        <p className="mt-3 text-xs leading-5 text-slate-400">
          设备未提供可靠位置反馈：外部客户端的移动无法自动识别，预置点指令也不能证明原布防视角已恢复。
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs leading-5 text-amber-200">
          {notice}
        </p>
      )}
      <p className="mt-4 text-[11px] leading-5 text-slate-400">
        方向键控制转动，＋／－控制镜头；空格停止，Esc 收起。1–9
        调用已设置的预置点。快捷键只在此面板内生效。摄像头控制与本地 360° 视角、画面放大分别独立。
      </p>
      <ConfirmDialog
        open={overwrite}
        title="覆盖预置点"
        content={`将把“${name}”替换为摄像头当前的位置和镜头状态，原位置无法通过此预置点恢复。`}
        busy={busy}
        onClose={() => setOverwrite(false)}
        onConfirm={() => {
          setOverwrite(false);
          void saveCurrent();
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除预置点"
        content={`将删除摄像头上的“${remove?.name ?? ''}”及其快捷入口。`}
        danger
        busy={busy}
        onClose={() => setRemove(null)}
        onConfirm={() => {
          const p = remove;
          setRemove(null);
          if (p)
            void action(async () => {
              await ptzService.remove(channelId, p.id);
              setEditPreset('');
              setName('');
              setShortcut('');
            });
        }}
      />
    </aside>
  );
}

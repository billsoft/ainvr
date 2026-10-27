import { useEffect, useState } from 'react';
import { request } from '@/api/httpClient';
import type { PtzSourceSelector, CameraPtzSettings, CameraPtzDraft } from '@/api/ptzService';
export type { PtzSourceSelector, CameraPtzSettings, CameraPtzDraft } from '@/api/ptzService';
export const cameraPtzKey = (s: PtzSourceSelector) =>
  s.protocol === 'onvif'
    ? `onvif:${s.deviceId}/${s.videoSource}`
    : `gb28181:${s.deviceId}/${s.channelId}`;
const defaults: CameraPtzSettings = { enabled: true, panTilt: null, zoom: null, presets: null };
export function PtzCameraFields({
  sources,
  onDraft,
  onBusy,
}: {
  sources: PtzSourceSelector[];
  onDraft: (draft: Record<string, CameraPtzDraft>) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [rows, setRows] = useState<
      { key: string; revision: number; settings: CameraPtzSettings }[]
    >([]),
    [value, setValue] = useState(defaults),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [mixed, setMixed] = useState(false);
  const encoded = JSON.stringify(sources);
  useEffect(() => {
    let live = true;
    onDraft({});
    setRows([]);
    setError('');
    setValue(defaults);
    if (!sources.length) {
      onBusy?.(false);
      return;
    }
    setLoading(true);
    onBusy?.(true);
    request<{ items: { key: string; revision: number; settings: CameraPtzSettings }[] }>(
      '/ptz/camera-configurations',
      {
        method: 'POST',
        body: JSON.stringify({ sources: JSON.parse(encoded) }),
        signal: AbortSignal.timeout(12000),
      },
    )
      .then((r) => {
        if (!live) return;
        if (!Array.isArray(r.items) || r.items.length !== sources.length)
          throw Error('invalid response');
        setRows(r.items);
        setValue(r.items[0]?.settings ?? defaults);
        setMixed(
          r.items.some((v) => JSON.stringify(v.settings) !== JSON.stringify(r.items[0]?.settings)),
        );
      })
      .catch(() => {
        if (live)
          setError('暂未读取云台配置，可保留原设置保存通道；需要修改云台能力时请重新打开向导。');
      })
      .finally(() => {
        if (live) {
          setLoading(false);
          onBusy?.(false);
        }
      });
    return () => {
      live = false;
      onBusy?.(false);
    };
  }, [encoded, onDraft, onBusy]);
  const change = (next: CameraPtzSettings) => {
    setValue(next);
    setMixed(false);
    onDraft(
      Object.fromEntries(
        rows.map((r) => [r.key, { expectedRevision: r.revision, settings: next }]),
      ),
    );
  };
  const gb = sources[0]?.protocol === 'gb28181';
  return (
    <details className="mt-4 rounded-xl border border-line bg-surface-page p-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-ink">
        摄像头云台与镜头控制{sources.length > 1 ? ` · ${sources.length} 个画面` : ''}
      </summary>
      <p className="mb-2 text-xs leading-5 text-ink-subtle">
        {gb
          ? '国标目录不能完整证明云台能力。请根据摄像头说明确认支持的功能，未确认的功能暂不开放。'
          : '默认从摄像头发现能力。固定摄像头不显示方向控制；有变焦能力时提供镜头控制。'}
      </p>
      {mixed && (
        <p className="mb-2 text-xs text-warning-700">
          所选画面配置不同；保持不动会分别保留，修改后统一应用到所选画面。
        </p>
      )}
      {loading && (
        <p role="status" className="text-xs text-ink-subtle">
          正在读取…
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-warning-700">
          {error}
        </p>
      )}
      <fieldset disabled={loading || !rows.length} className="mt-2 space-y-2 disabled:opacity-50">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => change({ ...value, enabled: e.target.checked })}
          />
          允许在实时监看中控制此摄像头
        </label>
        {(['panTilt', 'zoom', 'presets'] as const).map((flag) => (
          <label key={flag} className="flex min-h-11 items-center justify-between gap-3 text-sm">
            <span>{{ panTilt: '方向转动', zoom: '镜头变焦', presets: '预置点' }[flag]}</span>
            <select
              aria-label={
                { panTilt: '方向转动能力', zoom: '镜头变焦能力', presets: '预置点能力' }[flag]
              }
              disabled={!value.enabled}
              className="min-h-11 rounded-base border border-line bg-surface px-3"
              value={
                value[flag] === null || (!gb && value[flag] === true) ? 'auto' : String(value[flag])
              }
              onChange={(e) =>
                change({
                  ...value,
                  [flag]: e.target.value === 'auto' ? null : e.target.value === 'true',
                })
              }
            >
              <option value="auto">{gb ? '尚未确认' : '自动发现'}</option>
              {gb && <option value="true">已确认支持</option>}
              <option value="false">关闭此功能</option>
            </select>
          </label>
        ))}
      </fieldset>
      <p className="mt-2 text-xs leading-5 text-ink-faint">
        随通道一起保存。主、子码流共用物理云台；关闭其中一个画面的共享能力会约束同一云台的其他画面。录像和
        AI 检测继续运行；移动摄像头会暂停依赖原视角的布防。
      </p>
    </details>
  );
}

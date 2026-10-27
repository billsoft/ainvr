import { useEffect, useState } from 'react';
import { request } from '@/api/httpClient';
import { ptzError } from '@/api/ptzService';
type Settings = { enabled: boolean; capacity: number; leaseMs: number };
export function PtzGlobalSettings() {
  const [data, setData] = useState<{ revision: number; settings: Settings }>(),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    request<typeof data>('/ptz/settings')
      .then((r) => {
        if (
          !r ||
          !Number.isSafeInteger(r.revision) ||
          typeof r.settings?.enabled !== 'boolean' ||
          !Number.isSafeInteger(r.settings.capacity) ||
          !Number.isSafeInteger(r.settings.leaseMs)
        )
          throw Error('invalid configuration');
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setError('云台公共配置暂不可用');
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const leave = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, [key]: value } });
    setDirty(true);
    setMessage('');
  };
  const save = async () => {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{
        revision: number;
        settings: Settings;
        application?: { state: string };
      }>('/ptz/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings: data.settings, expectedRevision: data.revision }),
      });
      setData(result);
      setDirty(false);
      if (result.application?.state === 'stop_unconfirmed') {
        setMessage('云台公共配置已保存。');
        setError('部分摄像头停止尚未确认，请检查连接并在云台面板重试停止。');
      } else setMessage('云台公共配置已生效。');
    } catch (e) {
      setError(ptzError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ui-panel mt-4 p-5" data-unsaved={dirty}>
      <h2 className="font-semibold">云台公共配置</h2>
      <p className="mt-2 text-sm leading-6 text-ink-subtle">
        ONVIF 与国标共用此配置。摄像头账号、控制能力和预置点分别在对应通道与实时监看中设置。
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-sm text-success">
          {message}
        </p>
      )}
      {data && (
        <fieldset disabled={busy} className="mt-3 space-y-3">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.settings.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            允许控制摄像头云台与镜头
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              同时控制上限
              <input
                aria-label="同时控制上限"
                type="number"
                min={1}
                max={16}
                value={data.settings.capacity}
                onChange={(e) => set('capacity', Number(e.target.value))}
                className="form-input mt-1 min-h-11"
              />
            </label>
            <label className="text-sm">
              通信中断停止保护（秒）
              <input
                aria-label="通信中断停止保护（秒）"
                type="number"
                min={0.5}
                max={1.5}
                step={0.1}
                value={data.settings.leaseMs / 1000}
                onChange={(e) => set('leaseMs', Math.round(Number(e.target.value) * 1000))}
                className="form-input mt-1 min-h-11"
              />
            </label>
          </div>
          <p className="text-xs leading-5 text-ink-subtle">
            超过保护时间未收到续控时，由协议服务主动发起停止。摄像头网络完全中断时，停止结果仍需确认。保存此配置会结束当前云台操作。
          </p>
          <button
            type="button"
            className="btn-primary min-h-11"
            disabled={!dirty}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存云台公共配置'}
          </button>
        </fieldset>
      )}
    </section>
  );
}

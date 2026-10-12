import { Cpu, Fingerprint, RefreshCw } from 'lucide-react'
import { CopyButton } from '@/components/common/CopyButton'
import type { MachineCodeInfo } from '@/types/license'
import { downloadRequest } from './licenseFiles'

interface Props {
  machineCode: MachineCodeInfo | null
  loading: boolean
  unreachable: boolean
  onRefresh: () => void
}

/** Machine identity stays readable; signed grants use the full installation request. */
export function MachineCodeCard({ machineCode, loading, unreachable, onRefresh }: Props) {
  const code = machineCode?.machine_code ?? ''
  const request = machineCode?.activation_request
  const recovering = machineCode?.request_kind === 'recover'

  return (
    <section className="ui-panel p-5 sm:p-6" aria-labelledby="machine-code-title">
      <div className="flex items-center justify-between gap-3">
        <h2 id="machine-code-title" className="flex items-center gap-2 text-base font-semibold">
          <Fingerprint size={17} className="text-primary" aria-hidden />
          本机机器码
        </h2>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1 rounded-base px-2 py-1 text-xs text-ink-subtle transition-colors hover:bg-primary-50 hover:text-primary"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden />
          刷新
        </button>
      </div>

      <p className="mt-2 text-sm leading-6 text-ink-subtle">
        {request ? '请把完整授权申请发给供应商，注册码绑定本机和当前安装。短机器码用于核对设备。' : '申请授权时，请把下面的机器码发给供应商；注册码不能跨机器使用。'}
      </p>

      {code ? (
        <div className="mt-4 rounded-panel border border-line bg-surface-page p-4">
          <div className="flex items-start justify-between gap-3">
            <span className="select-all break-all font-mono text-lg font-semibold tracking-wider text-ink">
              {code}
            </span>
            <CopyButton value={code} className="shrink-0" />
          </div>
          {request && <div className="mt-4 space-y-2 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2 text-sm font-medium">
              <span>{recovering ? '恢复授权申请' : '完整授权申请'}</span>
              <CopyButton value={request} />
            </div>
            <textarea aria-label="完整授权申请" readOnly value={request} rows={3}
              className="w-full resize-none rounded-base border border-line bg-surface-page p-2 font-mono text-xs" />
            <button type="button" disabled={loading || unreachable}
              onClick={() => downloadRequest(request, code)}
              className="rounded-base border border-line px-3 py-2 text-sm disabled:opacity-50">
              下载申请文件
            </button>
            {recovering && <p role="status" className="text-sm text-ink-subtle">
              授权状态需要恢复。请提供这份新申请，由供应商核对原授权权益；旧注册码不能重新计时。
            </p>}
          </div>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1">
              <Cpu size={13} aria-hidden />
              {machineCode?.soc_model || '未知机型'}
            </span>
            {machineCode?.fingerprint_version && (
              <span>指纹版本 {machineCode.fingerprint_version}</span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-panel border border-dashed border-line p-4 text-sm text-ink-faint">
          {loading ? '正在读取机器码…' : unreachable ? '授权服务不可用，暂时读不到机器码' : '—'}
        </div>
      )}
    </section>
  )
}

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'

export function ConfigApplyOverlay({ busy, stage, remaining }: { busy: boolean; stage: string; remaining: number }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!busy) return
    const root = document.getElementById('root')
    const wasInert = root?.hasAttribute('inert')
    const previous = document.activeElement as HTMLElement | null
    root?.setAttribute('inert', '')
    panel.current?.focus()
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', unload)
    return () => {
      if (!wasInert) root?.removeAttribute('inert')
      window.removeEventListener('beforeunload', unload)
      if (previous?.isConnected) previous.focus()
    }
  }, [busy])
  if (!busy) return null
  return createPortal(<div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="配置更新中"
    className="fixed inset-0 z-[10000] flex items-start justify-center bg-black/30 pt-24">
    <div className="mx-4 max-w-lg rounded-xl border border-line bg-surface p-6 shadow-xl">
      <div className="flex items-center gap-2 font-semibold"><RefreshCw className="animate-spin" size={20} />配置更新中</div>
      <p role="status" className="mt-3 text-sm">{stage}</p>
      <p className="mt-2 text-xs text-ink-subtle">请勿关闭页面。最多再等待 {remaining} 秒；失败或超时会自动解除操作限制。</p>
    </div>
  </div>, document.body)
}

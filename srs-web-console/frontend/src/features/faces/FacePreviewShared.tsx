import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FlaskConical, ImageOff, X } from 'lucide-react'

export function FacePreviewNotice() {
  return <div role="note" className="rounded-base border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <div className="flex items-center gap-2 font-semibold"><FlaskConical size={18} aria-hidden />设计预览 · 未接入后台</div>
    <p className="mt-1 text-xs leading-5">仅演示人脸库与抓拍交互，不能正式启用。示例与真实记录隔离；草稿仅在当前页面内存中，离开或刷新即清空，不会保存到设备或触发告警。</p>
  </div>
}

export function FacePlaceholder() {
  return <div className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-2 rounded-base border border-dashed border-line bg-surface-page text-ink-faint" role="img" aria-label="人脸照片占位，无真实照片">
    <ImageOff size={24} aria-hidden /><span className="text-xs">照片占位</span>
  </div>
}

// Existing editors own their modal shell; no shared editable Modal is exported.
// Match that shell and reuse ConfirmDialog for the discard confirmation.
export function FacePreviewModal({ title, children, footer, onClose }: {
  title: string; children: ReactNode; footer?: ReactNode; onClose: () => void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const titleId = useId()
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    const opened = panel.current
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (!panel.current || dialogs[dialogs.length - 1] !== panel.current) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close.current()
      }
      if (event.key === 'Tab') {
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ))
        const first = controls[0], last = controls[controls.length - 1]
        if (!first) { event.preventDefault(); panel.current.focus() }
        else if (!panel.current.contains(document.activeElement) || document.activeElement === panel.current) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      document.body.style.overflow = overflow
      const remaining = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(node => node !== opened)
      const parent = remaining[remaining.length - 1]
      if (previous?.isConnected && (!parent || parent.contains(previous))) previous.focus()
      else parent?.focus()
    }
  }, [])
  return createPortal(<div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-3">
    <section className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-panel bg-surface shadow-modal">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <button type="button" aria-label="关闭" onClick={onClose} className="flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page"><X size={18} aria-hidden /></button>
      </header>
      <div className="min-h-0 space-y-4 overflow-y-auto p-4">{children}</div>
      {footer && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line p-3">{footer}</footer>}
    </section>
  </div>, document.fullscreenElement ?? document.body)
}

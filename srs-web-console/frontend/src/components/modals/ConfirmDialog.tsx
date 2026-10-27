import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TriangleAlert, X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  content?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  autoClose?: boolean
  /** 需输入指定文字才能确认（高危操作防误删） */
  requireText?: string
  onConfirm: () => void
  onClose: () => void
}

/** 确认弹窗（删除通道等破坏性操作，DEV_PLAN 4.6） */
export function ConfirmDialog({
  open,
  title,
  content,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  busy = false,
  autoClose = true,
  requireText,
  onConfirm,
  onClose,
}: Props) {
  const [typed, setTyped] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const current = useRef({ busy, onClose })
  useEffect(() => {
    current.current = { busy, onClose }
  }, [busy, onClose])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const openedPanel = dialog.current
    setTyped('')
    const initial = dialog.current?.querySelector<HTMLInputElement>('input')
    ;(initial ?? cancel.current)?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const panel = dialog.current
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (!panel || stack[stack.length - 1] !== panel) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!current.current.busy) current.current.onClose()
      } else if (event.key === 'Tab') {
        event.stopPropagation()
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled])',
        ))
        const first = controls[0], last = controls[controls.length - 1]
        if (!first) {
          event.preventDefault()
          panel.focus()
        } else if (!panel.contains(document.activeElement)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    // Pointer clicks on non-focusable dialog content can leave focus on body.
    // Handle keys at document capture, and only for the topmost dialog.
    document.addEventListener('keydown', keyboard, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      // Discarding an inner editor can remove the original opener. Restore
      // inside the remaining modal instead of exposing background controls.
      const remaining = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      )).filter((panel) => panel !== openedPanel)
      const parent = remaining[remaining.length - 1]
      if (previous?.isConnected && !previous.matches(':disabled') &&
          (!parent || parent.contains(previous))) {
        previous.focus()
      } else if (parent) {
        const control = parent.querySelector<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"]):not(:disabled)',
        )
        ;(control ?? parent).focus()
      }
    }
  }, [open])

  if (!open) return null
  const needText = requireText != null
  const canConfirm = !needText || typed === requireText

  return createPortal(
    <div
      ref={dialog}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-3"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <div className="relative w-full max-w-[420px] rounded-panel bg-surface p-6 shadow-modal">
        <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}
          className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page disabled:opacity-40">
          <X size={18} aria-hidden />
        </button>
        <div className="flex items-start gap-3">
          {danger && (
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0 pr-8">
            <h3 className="text-base font-semibold text-ink">{title}</h3>
            {content && <p className="mt-1.5 text-sm text-ink-subtle">{content}</p>}
          </div>
        </div>

        {needText && (
          <div className="mt-4">
            <label className="text-xs text-ink-subtle">
              请输入 <span className="font-semibold text-ink">{requireText}</span> 以确认：
            </label>
            <input
              disabled={busy}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 w-full rounded-base border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
              data-testid="confirm-input"
            />
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            ref={cancel}
            onClick={onClose}
            disabled={busy}
            className="min-h-11 rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={!canConfirm || busy}
            onClick={() => {
              onConfirm()
              if (autoClose) onClose()
            }}
            className={[
              'min-h-11 rounded-base px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40',
              danger ? 'bg-danger hover:bg-danger/90' : 'bg-primary hover:bg-primary-600',
            ].join(' ')}
            data-testid="confirm-ok"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  )
}

import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  content?: string
  confirmText?: string
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
  danger = false,
  busy = false,
  autoClose = true,
  requireText,
  onConfirm,
  onClose,
}: Props) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])

  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  if (!open) return null
  const needText = requireText != null
  const canConfirm = !needText || typed === requireText

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-[420px] rounded-panel bg-surface p-6 shadow-modal">
        <div className="flex items-start gap-3">
          {danger && (
            <TriangleAlert size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          )}
          <div className="min-w-0">
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
              autoFocus
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
            onClick={onClose}
            disabled={busy}
            className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canConfirm || busy}
            onClick={() => {
              onConfirm()
              if (autoClose) onClose()
            }}
            className={[
              'rounded-base px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40',
              danger ? 'bg-danger hover:bg-danger/90' : 'bg-primary hover:bg-primary-600',
            ].join(' ')}
            data-testid="confirm-ok"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

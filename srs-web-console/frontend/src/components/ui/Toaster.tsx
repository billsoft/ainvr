import { CircleCheck, CircleX, Info } from 'lucide-react'
import { useToastStore, type ToastKind } from '@/store/toast'

const ICON: Record<ToastKind, typeof Info> = {
  success: CircleCheck,
  error: CircleX,
  info: Info,
}
const STYLE: Record<ToastKind, string> = {
  success: 'border-success/30 text-ink',
  error: 'border-danger/40 text-ink',
  info: 'border-primary-200 text-ink',
}
const ICON_COLOR: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-primary',
}

/** 全局 Toast 容器（挂在 AppLayout，顶部居中） */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div
      className="fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = ICON[t.kind]
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={[
              'flex items-center gap-2 rounded-base border bg-surface px-4 py-2.5 text-sm shadow-modal transition-opacity',
              STYLE[t.kind],
            ].join(' ')}
          >
            <Icon size={16} className={ICON_COLOR[t.kind]} aria-hidden />
            <span>{t.message}</span>
          </button>
        )
      })}
    </div>
  )
}

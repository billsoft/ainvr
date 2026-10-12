import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}

/** 空状态占位（DEV_PLAN 4.5） */
export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center rounded-panel border border-dashed border-line bg-surface py-16 text-center">
      <Icon size={40} className="text-ink-faint" aria-hidden />
      <p className="mt-3 text-sm font-medium text-ink">{title}</p>
      {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

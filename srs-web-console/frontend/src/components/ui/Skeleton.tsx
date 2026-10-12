interface SkeletonProps {
  className?: string
}

/**
 * 骨架屏占位（纯 CSS 脉冲动画）
 */
export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-base bg-ink-100 ${className}`}
      aria-hidden
    />
  )
}

/** 文本行骨架 */
export function SkeletonText({ lines = 1, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4" />
      ))}
    </div>
  )
}

/** 卡片骨架 */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={`rounded-panel border border-line bg-surface p-4 shadow-sm ${className}`}>
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-5 w-5 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-7 w-24" />
    </div>
  )
}

/** 表格行骨架 */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-3">
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className={`h-4 ${i === 0 ? 'flex-1' : 'w-20'}`} />
      ))}
    </div>
  )
}

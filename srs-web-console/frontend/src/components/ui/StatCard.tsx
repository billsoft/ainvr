// 统计卡片——原本是 Dashboard 页面的私有组件，系统资源页要用同一种卡片，
// 2026-09-10 抽成共用组件，Dashboard 改成从这里导入，渲染逻辑没有变化。

export type StatCardColor = 'primary' | 'success' | 'info' | 'warning' | 'danger'

const COLOR_MAP: Record<StatCardColor, string> = {
  primary: 'from-primary-50 to-primary-100 text-primary-700 border-primary-200',
  success: 'from-success-50 to-success-100 text-success-700 border-success-200',
  info: 'from-info-50 to-info-100 text-info-700 border-info-200',
  warning: 'from-warning-50 to-warning-100 text-warning-700 border-warning-200',
  danger: 'from-danger-50 to-danger-100 text-danger-700 border-danger-200',
}

interface StatCardProps {
  label: string
  value: number | string
  suffix: string
  icon: string
  color: StatCardColor
}

export function StatCard({ label, value, suffix, icon, color }: StatCardProps) {
  return (
    <div
      className={`rounded-panel border bg-gradient-to-br p-4 shadow-sm ${COLOR_MAP[color]}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium opacity-70">{label}</span>
        <span className="text-xl" aria-hidden>{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-2xl font-bold">{value}</span>
        <span className="text-xs opacity-60">{suffix}</span>
      </div>
    </div>
  )
}

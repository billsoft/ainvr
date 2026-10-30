import { NavLink } from 'react-router-dom'
import { Search, Bell, ScanLine, Clapperboard, ChartColumn, Footprints, Gauge, History, Info, Layers, MonitorPlay, ScanFace, Video, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useMonitorStore } from '@/store/monitor'
import { displayVersion, useBranding } from '@/store/branding'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: '仪表盘', icon: Gauge },
  { to: '/ai-channels', label: 'AI 通道', icon: ScanFace },
  { to: '/channels', label: '接入管理', icon: Video },
  { to: '/monitor', label: '实时监看', icon: MonitorPlay },
  { to: '/playback', label: '录像回放', icon: Clapperboard },
  { to: '/recognition-history', label: '识别历史', icon: History },
  { to: '/smart-search', label: '智能搜索', icon: Search },
  { to: '/alarm-analysis', label: '告警触发', icon: ScanLine },
  { to: '/alarms', label: '告警列表', icon: Bell },
  { to: '/flow-statistics', label: '流量统计', icon: Footprints },
  { to: '/analytics', label: '统计分析', icon: ChartColumn },
  { to: '/config-center', label: '系统配置', icon: Layers },
  { to: '/about', label: '关于', icon: Info },
]

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

/**
 * 侧边栏导航
 * - lg 及以上：常驻 208px 侧边栏
 * - lg 以下：抽屉式，open=true 时从左侧滑入，带遮罩层
 */
export function Sidebar({ open = true, onClose }: SidebarProps) {
  const branding = useBranding()
  return (
    <>
      {/* 移动端遮罩 */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={[
          'z-40 flex w-52 shrink-0 flex-col border-r border-line bg-surface transition-transform duration-200',
          // 桌面端常驻
          'lg:static lg:translate-x-0',
          // 移动端抽屉
          'fixed inset-y-0 left-0',
          open ? 'visible translate-x-0' : 'invisible -translate-x-full lg:visible lg:translate-x-0',
        ].join(' ')}
      >
        <nav className="flex flex-1 flex-col gap-1 p-3" aria-label="主导航">
          {/* 移动端关闭按钮 */}
          <div className="mb-2 flex items-center justify-between lg:hidden">
            <span className="px-2 text-xs font-medium text-ink-faint">导航</span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-base p-1 text-ink-subtle hover:bg-primary-50 hover:text-primary"
              aria-label="关闭菜单"
            >
              <X size={18} />
            </button>
          </div>

          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => {
                // 从聚焦态点回"实时监看"应该重置回全景（幂等，非聚焦态时无副作用）
                if (to === '/monitor') useMonitorStore.getState().exitFocus()
                // 移动端点击导航项后自动关闭
                if (onClose && window.innerWidth < 1024) onClose()
              }}
              className={({ isActive }) =>
                [
                  'relative flex items-center gap-3 rounded-base px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-100 text-primary-600'
                    : 'text-ink-subtle hover:bg-primary-50 hover:text-ink',
                ].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden
                    className={[
                      'absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary',
                      isActive ? 'opacity-100' : 'opacity-0',
                    ].join(' ')}
                  />
                  <Icon size={18} strokeWidth={isActive ? 2.4 : 2} aria-hidden />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line px-4 py-3 text-xs text-ink-faint">
          {branding && [branding.shortName, displayVersion(branding)].filter(Boolean).join(' ')}
        </div>
      </aside>
    </>
  )
}

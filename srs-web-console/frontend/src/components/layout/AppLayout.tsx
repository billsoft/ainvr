import { useState } from 'react'
import { useSettingsSync } from '@/hooks/useSettingsSync'
import { Outlet, useLocation } from 'react-router-dom'
import { useLicenseStore } from '@/store/license'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { LicenseGateOverlay } from './LicenseGateOverlay'
import { SystemTimeNotice } from './SystemTimeNotice'
import { isLicenseRecoveryRoute } from './licenseRecoveryRoutes'
import { Menu } from 'lucide-react'

/**
 * 全局布局：顶栏通栏 + 左侧边栏(208px) + 主内容区
 * 响应式：lg 以下侧边栏默认收起，可通过菜单按钮展开抽屉
 */
export function AppLayout() {
  useSettingsSync()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const block = useLicenseStore((s) => s.gateBlock)
  const { pathname } = useLocation()
  const management = isLicenseRecoveryRoute(pathname)

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Topbar>
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          className="mr-2 rounded-base p-1.5 text-ink-subtle hover:bg-primary-50 hover:text-primary lg:hidden"
          aria-label={sidebarOpen ? '关闭菜单' : '打开菜单'}
          aria-expanded={sidebarOpen}
        >
          <Menu size={20} />
        </button>
      </Topbar>

      <div className="flex min-h-0 flex-1">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <main className="min-w-0 flex-1 overflow-y-auto bg-surface-page p-4 sm:p-6">
          <SystemTimeNotice />
          {(!block || management) && <Outlet />}
        </main>
      </div>

      {/* 授权门控：仅在后端门控实际拦截（503）时出现，门控关闭时零影响 */}
      <LicenseGateOverlay />
    </div>
  )
}

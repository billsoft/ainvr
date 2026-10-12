import { AlertOctagon } from 'lucide-react'
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom'

/** 路由层错误边界——react-router v6.4+ 的 errorElement 机制天然会捕获
 * 该路由元素树渲染期抛出的异常（不只是 loader/action 抛错），且只替换
 * 命中这条边界的那段路由内容，不会带垮定义在祖先路由上的其它部分
 * （如挂在根路由时，AppLayout 侧边栏依然正常渲染，只是 Outlet 内容变成这个）。
 *
 * 此前全站零 ErrorBoundary：任意页面一次没预料到的渲染期异常会把整棵
 * React 树连根卸载，代价是把 Dashboard/Channels/Monitor 全部页面一起
 * 拖下水变成白屏，用户唯一的恢复手段是手动刷新整个页面。 */
export function RouteErrorBoundary() {
  const error = useRouteError()
  const navigate = useNavigate()

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : '未知错误'

  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-panel border border-danger-200 bg-danger-50 p-8 text-center">
      <AlertOctagon size={32} className="text-danger" aria-hidden />
      <p className="text-sm font-medium text-ink">页面出错了</p>
      <p className="max-w-md text-xs text-ink-subtle">{message}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => navigate(0)}
          className="rounded-base bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
        >
          重新加载
        </button>
        <button
          type="button"
          onClick={() => navigate('/dashboard')}
          className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
        >
          返回首页
        </button>
      </div>
    </div>
  )
}

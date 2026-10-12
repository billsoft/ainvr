import { Navigate, createBrowserRouter } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import ChannelsPage from '@/pages/Channels'
import ChannelDetailPage from '@/pages/Channels/ChannelDetail'
import MonitorPage from '@/pages/Monitor'
import PlaybackPage from '@/pages/Playback'
import ConfigCenterPage from '@/pages/ConfigCenter'
import AboutPage from '@/pages/About'
import DashboardPage from '@/pages/Dashboard'
import AiChannelsPage from '@/pages/AiChannels'
import RecognitionHistoryPage from '@/pages/RecognitionHistory'
import { RouteErrorBoundary } from '@/components/common/RouteErrorBoundary'

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    // 兜底：没有单独 errorElement 的路由（Dashboard/Channels/Monitor/
    // Settings/About）渲染期抛错会冒泡到这里——根路由的 errorElement 会
    // 整体替换掉 element（AppLayout 连带侧边栏），不再是子路由那种"只换
    // Outlet 内容、侧边栏原样保留"的局部替换（AppLayout 本身不接受/渲染
    // children，硬塞进去也会被忽略，索性不装样子）。全页错误态好过此前
    // "整个 React 树连根卸载、必须手动刷新"的白屏。
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/monitor" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'channels', element: <ChannelsPage /> },
      { path: 'channels/:id', element: <ChannelDetailPage /> },
      {
        path: 'ai-channels',
        element: <AiChannelsPage />,
        // AI 通道页是本仓库最新、测试覆盖相对最年轻的一块，单独包一层——
        // 它出渲染期异常时只有这一页的内容变成错误态，侧边栏和其它页面
        // 不受影响，用户可以直接点侧边栏切走，不需要碰到上面那层根兜底。
        errorElement: <RouteErrorBoundary />,
      },
      { path: 'monitor', element: <MonitorPage /> },
      {
        // 录像回放：/playback 与 /playback/:channelId 同页（对齐识别历史/
        // 实时监看的双路由单组件做法，channelId 仅表示当前选中通道）。
        path: 'playback',
        element: <PlaybackPage />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: 'playback/:channelId',
        element: <PlaybackPage />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        // 左侧通道列表+右侧时间轴合并成一个组件，channelId 只是"当前选中
        // 哪个通道"——两条路由渲染同一个 RecognitionHistoryPage，不是
        // 概况页/详情页两个不同页面（2026-09-10 重构，对齐 Monitor 页布局）。
        path: 'recognition-history',
        element: <RecognitionHistoryPage />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: 'recognition-history/:channelId',
        element: <RecognitionHistoryPage />,
        errorElement: <RouteErrorBoundary />,
      },
      {
        path: 'system-resources',
        element: <Navigate to="/dashboard" replace />,
        errorElement: <RouteErrorBoundary />,
      },
      // 旧「系统设置」页已并入配置中心，旧书签/深链直接重定向
      { path: 'settings', element: <Navigate to="/config-center" replace /> },
      { path: 'config-center', element: <ConfigCenterPage /> },
      { path: 'license', element: <Navigate to="/config-center?category=license" replace /> },
      // 2026-09-22：网络管理从一级菜单并入配置中心第 6 个分类，旧书签同理重定向
      { path: 'network', element: <Navigate to="/config-center?category=network" replace /> },
      { path: 'about', element: <AboutPage /> },
      { path: '*', element: <Navigate to="/monitor" replace /> },
    ],
  },
])

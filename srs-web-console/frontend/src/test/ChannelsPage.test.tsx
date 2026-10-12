import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { mockChannels } from '@/mock/channels'
import { useChannelsStore } from '@/store/channels'

vi.mock('@/api/channelService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/channelService')>()
  return {
    ...actual,
    channelService: actual.createMockChannelService(mockChannels),
  }
})

import ChannelsPage from '@/pages/Channels'

/** 每个用例独立内存路由 + 重新 mock（模块级单例在文件内共享） */
function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/channels', element: <ChannelsPage /> },
      { path: '/channels/:id', element: <div>detail page</div> },
    ],
    { initialEntries: ['/channels'] },
  )
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  // 重置全局 store 状态避免用例间污染
  useChannelsStore.setState({
    channels: [],
    loading: false,
    error: null,
    search: '',
  })
})

describe('ChannelsPage 通道列表', () => {
  it('渲染 mock 种子数据的 5 行通道', async () => {
    renderPage()
    for (const name of ['大门摄像头', '后门摄像头', '会议室直播', '停车场全景', '前台接待']) {
      expect(await screen.findByText(name)).toBeInTheDocument()
    }
    expect(screen.getByText(/共 5 个通道/)).toBeInTheDocument()
    expect(screen.getByText(/3 个在线/)).toBeInTheDocument()
  })

  it('搜索"大门"过滤为 1 行', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('大门摄像头')
    await user.type(screen.getByTestId('channel-search'), '大门')
    await waitFor(() => {
      expect(screen.queryByText('后门摄像头')).not.toBeInTheDocument()
    })
    expect(screen.getByText('大门摄像头')).toBeInTheDocument()
  })

  it('搜索无结果显示空状态并可清空', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('大门摄像头')
    await user.type(screen.getByTestId('channel-search'), '不存在的关键词')
    expect(await screen.findByText('没有找到匹配的通道')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(await screen.findByText('大门摄像头')).toBeInTheDocument()
  })


  it('点击"新建通道"打开向导', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('大门摄像头')
    await user.click(screen.getByTestId('btn-new-channel'))
    expect(await screen.findByRole('dialog', { name: '新建通道' })).toBeInTheDocument()
    expect(screen.getByText('基本信息')).toBeInTheDocument()
  })

  it('点击名称进入详情路由', async () => {
    const user = userEvent.setup()
    renderPage()
    const row = await screen.findByTestId('channel-row-ch-003')
    await user.click(within(row).getByRole('link', { name: '会议室直播' }))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
  })

  it('删除流程：确认框输入通道名后才可删除，删除后行消失', async () => {
    const user = userEvent.setup()
    renderPage()
    const row = await screen.findByTestId('channel-row-ch-001')
    await user.click(within(row).getByTitle('删除'))
    const dialog = await screen.findByRole('dialog', { name: '删除通道' })
    expect(within(dialog).getByTestId('confirm-ok')).toBeDisabled()
    await user.type(within(dialog).getByTestId('confirm-input'), '大门摄像头')
    await user.click(within(dialog).getByTestId('confirm-ok'))
    await waitFor(() => {
      expect(screen.queryByTestId('channel-row-ch-001')).not.toBeInTheDocument()
    })
    expect(screen.getByText('通道「大门摄像头」已删除')).toBeInTheDocument()
  })
})

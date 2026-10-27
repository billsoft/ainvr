import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { StatusBadge } from '@/components/common/StatusBadge'
import { ProtocolTag } from '@/components/common/ProtocolTag'
import { CopyButton } from '@/components/common/CopyButton'
import { EmptyState } from '@/components/common/EmptyState'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'
import { Toaster } from '@/components/ui/Toaster'
import { toast, useToastStore } from '@/store/toast'
import { Camera } from 'lucide-react'

describe('StatusBadge', () => {
  it('在线显示绿色"在线"，离线显示"离线"', () => {
    const { unmount } = render(<StatusBadge online />)
    expect(screen.getByText('在线')).toBeInTheDocument()
    const badge = screen.getByText('在线').closest('span')!
    expect(badge.className).toContain('text-success')
    unmount()
    render(<StatusBadge online={false} />)
    expect(screen.getByText('离线')).toBeInTheDocument()
  })
})

describe('ProtocolTag', () => {
  it('渲染协议名', () => {
    render(<ProtocolTag label="RTMP" />)
    expect(screen.getByText('RTMP')).toBeInTheDocument()
  })
})

describe('CopyButton', () => {
  let writeText: ReturnType<typeof vi.fn>
  beforeEach(() => {
    writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('点击复制并把文案短暂换成"已复制"（fireEvent：user-event 会 stub clipboard）', async () => {
    const onCopied = vi.fn()
    render(<CopyButton value="rtmp://x" onCopied={onCopied} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rtmp://x'))
    expect(onCopied).toHaveBeenCalledOnce()
    expect(screen.getByText('已复制')).toBeInTheDocument()
    await waitFor(
      () => expect(screen.queryByText('已复制')).not.toBeInTheDocument(),
      { timeout: 3000 },
    )
  })

  it('clipboard 失败时走 execCommand 兜底', async () => {
    writeText.mockRejectedValueOnce(new Error('not allowed'))
    const exec = vi.fn(() => true)
    document.execCommand = exec as unknown as typeof document.execCommand
    render(<CopyButton value="abc" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(exec).toHaveBeenCalledWith('copy'))
    expect(screen.getByText('已复制')).toBeInTheDocument()
  })
})

describe('EmptyState', () => {
  it('渲染图标标题描述与动作', () => {
    render(
      <EmptyState
        icon={Camera}
        title="还没有通道"
        description="创建第一个"
        action={<button>新建</button>}
      />,
    )
    expect(screen.getByText('还没有通道')).toBeInTheDocument()
    expect(screen.getByText('创建第一个')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
  })
})

describe('ConfirmDialog', () => {
  it('open=false 不渲染', () => {
    render(<ConfirmDialog open={false} title="删除" onConfirm={() => {}} onClose={() => {}} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('普通确认：点击确认触发 onConfirm 并关闭', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <ConfirmDialog
        open
        title="确认踢流？"
        confirmText="踢流"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    )
    await user.click(screen.getByTestId('confirm-ok'))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('requireText 模式：输入不匹配禁用确认，匹配后可用', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog
        open
        title="删除通道"
        danger
        requireText="大门摄像头"
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    )
    const ok = screen.getByTestId('confirm-ok')
    expect(ok).toBeDisabled()
    await user.type(screen.getByTestId('confirm-input'), '大门摄像头')
    expect(ok).toBeEnabled()
    await user.click(ok)
    expect(onConfirm).toHaveBeenCalledOnce()
  })
  it('点遮罩保留确认，Esc 与取消走同一关闭流程', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ConfirmDialog open title="x" onConfirm={() => {}} onClose={onClose} />)
    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    onClose.mockClear()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('Toast', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('push 后渲染、超时自动消失', () => {
    render(<Toaster />)
    act(() => {
      toast.success('创建成功')
    })
    expect(screen.getByText('创建成功')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3100)
    })
    expect(screen.queryByText('创建成功')).not.toBeInTheDocument()
  })
  it('error 默认 5 秒自动消失', () => {
    render(<Toaster />)
    act(() => {
      toast.error('出错了')
    })
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText('出错了')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1100)
    })
    expect(screen.queryByText('出错了')).not.toBeInTheDocument()
  })
})

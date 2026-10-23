import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DateTimeRangePicker } from '@/components/ui/DateTimeRangePicker'

// 真正的滚轮物理（拖拽速度追踪、惯性减速动画）来自 @ncdai/react-wheel-picker
// ——一个 777 star、MIT 协议的现成库，物理引擎不该由这份测试重新验证。
// 这里只关心"我们接的线对不对"：options/value/onValueChange 有没有正确
// 传过去、点某个值会不会正确回调。桩成一组按钮，比真实拖拽/RAF动画好测
// 得多，也不依赖 jsdom 不支持的滚动布局。
vi.mock('@ncdai/react-wheel-picker', () => ({
  WheelPickerWrapper: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  WheelPicker: ({ options, value, onValueChange }: {
    options: { value: number; label: string }[]
    value: number
    onValueChange: (v: number) => void
  }) => (
    <div>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onValueChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}))
vi.mock('@ncdai/react-wheel-picker/style.css', () => ({}))

function setup(props: Partial<Parameters<typeof DateTimeRangePicker>[0]> = {}) {
  const onConfirm = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <DateTimeRangePicker
      open
      from="2026-09-17T16:25:00"
      to="2026-09-17T16:35:00"
      onConfirm={onConfirm}
      onClose={onClose}
      {...props}
    />,
  )
  return { ...utils, onConfirm, onClose }
}

/** 在指定面板里，点击某个时/分/秒滚轮列上显示为 `label` 的格子。 */
function clickWheelItem(panel: HTMLElement, wheelTestId: string, label: string) {
  const wheel = within(panel).getByTestId(wheelTestId)
  return userEvent.click(within(wheel).getByRole('button', { name: label }))
}

describe('DateTimeRangePicker —— 打开/关闭', () => {
  it('open=false 时不渲染任何内容', () => {
    render(<DateTimeRangePicker open={false} from="" to="" onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('打开时从 props.from/to 播种草稿——两个面板的时分秒滚轮显示对应值', () => {
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    const toPanel = screen.getByTestId('range-picker-to')
    expect(within(within(fromPanel).getByTestId('range-picker-from-hh')).getByRole('button', { name: '16' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(fromPanel).getByTestId('range-picker-from-mm')).getByRole('button', { name: '25' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(fromPanel).getByTestId('range-picker-from-ss')).getByRole('button', { name: '00' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(toPanel).getByTestId('range-picker-to-mm')).getByRole('button', { name: '35' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('from/to 为空串时兜底为最近 10 分钟，不崩溃', () => {
    setup({ from: '', to: '' })
    expect(screen.getByTestId('range-picker-from')).toBeInTheDocument()
    expect(screen.getByTestId('range-picker-to')).toBeInTheDocument()
  })

  it('from/to 没带秒（旧格式/预设算出来的分钟精度字符串）——秒按 0 播种，不崩溃', () => {
    setup({ from: '2026-09-17T16:25', to: '2026-09-17T16:35' })
    const fromPanel = screen.getByTestId('range-picker-from')
    expect(within(within(fromPanel).getByTestId('range-picker-from-ss')).getByRole('button', { name: '00' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('点击遮罩不关闭（避免误触丢失已选时间）', async () => {
    const { onClose, onConfirm } = setup()
    await userEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('按 Escape 取消草稿，不应用范围', async () => {
    const { onClose, onConfirm } = setup()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('点击"取消"关闭，不调用 onConfirm', async () => {
    const { onClose, onConfirm } = setup()
    await userEvent.click(screen.getByTestId('range-picker-cancel'))
    expect(onClose).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('DateTimeRangePicker —— 两个面板各自独立', () => {
  it('点起始面板的某一天只影响起始时间，不影响结束时间', async () => {
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByRole('button', { name: '2026年9月10日' }))

    // 起始面板的时分秒不变（只有日期变了），结束面板完全不受影响
    expect(within(within(fromPanel).getByTestId('range-picker-from-hh')).getByRole('button', { name: '16' }))
      .toHaveAttribute('aria-pressed', 'true')
    const toPanel = screen.getByTestId('range-picker-to')
    expect(within(within(toPanel).getByTestId('range-picker-to-mm')).getByRole('button', { name: '35' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('月份导航——点"下个月"只切换标题，不改变已选日期/时间', async () => {
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    expect(within(fromPanel).getByText('2026年9月')).toBeInTheDocument()
    await userEvent.click(within(fromPanel).getByLabelText('下个月'))
    expect(within(fromPanel).getByText('2026年10月')).toBeInTheDocument()
    expect(within(within(fromPanel).getByTestId('range-picker-from-hh')).getByRole('button', { name: '16' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('点月份标题进入年月网格，选某月后回到日视图', async () => {
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByText('2026年9月'))
    await userEvent.click(within(fromPanel).getByText('12月'))
    expect(within(fromPanel).getByText('2026年12月')).toBeInTheDocument()
    expect(within(fromPanel).getByRole('button', { name: '2026年12月1日' })).toBeInTheDocument()
  })

  it('起始面板"今天"——把日期改成今天，时分秒不变', async () => {
    const REAL_NOW = new Date()
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByText('今天'))
    expect(within(fromPanel).getByRole('button', { name: `${REAL_NOW.getFullYear()}年${REAL_NOW.getMonth() + 1}月${REAL_NOW.getDate()}日` }))
      .toHaveAttribute('aria-pressed', 'true')
    // 时分秒保留原来选的 16:25:00，不是被"今天"顺带清零
    expect(within(within(fromPanel).getByTestId('range-picker-from-hh')).getByRole('button', { name: '16' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('起始面板"00:00"——把时分秒都归零，日期不变', async () => {
    setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByText('00:00'))
    expect(within(within(fromPanel).getByTestId('range-picker-from-hh')).getByRole('button', { name: '00' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(fromPanel).getByTestId('range-picker-from-mm')).getByRole('button', { name: '00' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(fromPanel).getByTestId('range-picker-from-ss')).getByRole('button', { name: '00' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('结束面板"23:59"——把时分秒设为当天最后一秒', async () => {
    setup()
    const toPanel = screen.getByTestId('range-picker-to')
    await userEvent.click(within(toPanel).getByText('23:59'))
    expect(within(within(toPanel).getByTestId('range-picker-to-hh')).getByRole('button', { name: '23' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(toPanel).getByTestId('range-picker-to-mm')).getByRole('button', { name: '59' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(within(within(toPanel).getByTestId('range-picker-to-ss')).getByRole('button', { name: '59' }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('结束面板"此刻"——整体替换成当前真实时间（日期也一起换）', async () => {
    setup()
    const toPanel = screen.getByTestId('range-picker-to')
    await userEvent.click(within(toPanel).getByText('此刻'))
    const now = new Date()
    expect(within(toPanel).getByRole('button', { name: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日` }))
      .toHaveAttribute('aria-pressed', 'true')
  })

  it('分/秒滚轮点击独立生效——改分钟不影响小时和秒', async () => {
    const { onConfirm } = setup()
    const fromPanel = screen.getByTestId('range-picker-from')
    await clickWheelItem(fromPanel, 'range-picker-from-mm', '05')
    await userEvent.click(screen.getByTestId('range-picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('2026-09-17T16:05:00', '2026-09-17T16:35:00')
  })
})

describe('DateTimeRangePicker —— 校验与确定', () => {
  it('起始时间晚于结束时间——显示提示，确定按钮禁用', async () => {
    setup({ from: '2026-09-17T18:00:00', to: '2026-09-17T10:00:00' })
    expect(screen.getByText('起始时间不能晚于结束时间')).toBeInTheDocument()
    expect(screen.getByTestId('range-picker-confirm')).toBeDisabled()
  })

  it('合法范围——点确定把带秒的 datetime-local 格式 from/to 传给 onConfirm，并关闭', async () => {
    const { onConfirm, onClose } = setup()
    await userEvent.click(screen.getByTestId('range-picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('2026-09-17T16:25:00', '2026-09-17T16:35:00')
    expect(onClose).toHaveBeenCalled()
  })

  it('底部摘要显示范围（带秒）与时长', () => {
    setup()
    expect(screen.getByText(/09-17 16:25:00/)).toBeInTheDocument()
    expect(screen.getByText(/09-17 16:35:00/)).toBeInTheDocument()
    expect(screen.getByText(/共 10 分钟/)).toBeInTheDocument()
  })
})

it('caller capacity validation keeps the picker open without applying invalid dates',async()=>{
 const {onConfirm,onClose}=setup({validateRange:()=> '流量统计每次最多查询 31 天'})
 expect(screen.getByRole('alert')).toHaveTextContent('31 天')
 expect(screen.getByTestId('range-picker-confirm')).toBeDisabled()
 await userEvent.click(screen.getByTestId('range-picker-confirm'))
 expect(onConfirm).not.toHaveBeenCalled();expect(onClose).not.toHaveBeenCalled()
 await userEvent.click(screen.getByRole('button',{name:'关闭'}))
 expect(onClose).toHaveBeenCalledOnce()
})

import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RecordingTimeline } from '@/pages/Playback/RecordingTimeline'
import { DAY_MS } from '@/utils/recording'
import type { RecordingSegment } from '@/types/recording'

// jsdom 没有 Pointer Capture 实现，组件里有调用，stub 成 no-op
Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {})
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {})
// 时间范围弹窗内部用 WheelColumn（时/分/秒滚轮）渲染，挂载就会调 scrollTo
// 对齐位置——jsdom 同样没有真实实现。
Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {})

const DAY_START = new Date('2026-09-16T00:00:00').getTime()

function seg(startOffMin: number, durSec = 60, idSuffix = ''): RecordingSegment {
  const start = DAY_START + startOffMin * 60_000
  return {
    id: `seg-${startOffMin}${idSuffix}`,
    channelId: 'ch1',
    startTs: start,
    endTs: start + durSec * 1000,
    durationMs: durSec * 1000,
    sizeBytes: 1000,
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 25,
    hasAudio: true,
    storage: 'local',
    playable: true,
  } as RecordingSegment
}

/** 把时间轴轨道伪装成 1000px 宽，clientX 即可直接换算成天内位置 */
function stubTrackRect() {
  const track = screen.getByRole('slider', { name: '录像时间轴' })
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0,
    width: 1000, height: 64, right: 1000, bottom: 64,
    toJSON: () => ({}),
  } as DOMRect)
  return track
}

function ControlledTimeline(props: React.ComponentProps<typeof RecordingTimeline>) {
  const [preset, setPreset] = useState<string | null>(null)
  return <RecordingTimeline {...props} selectedPreset={preset} onChangeRange={(from, to, label) => { setPreset(label); props.onChangeRange(from, to, label) }} />
}

describe('RecordingTimeline 指针定位与时间气泡', () => {
  // 组件 useLayoutEffect 读 clientWidth 做边缘 clamp，jsdom 默认 0
  beforeAll(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
  })

  it('点击段内位置：onSeek 拿到精确时刻，不吸附到段边界', () => {
    const onSeek = vi.fn()
    // 12:00:00–12:01:00 一段
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[seg(12 * 60)]}
        playheadTs={null}
        onSeek={onSeek}
        onChangeRange={() => {}}
      />,
    )
    const track = stubTrackRect()
    // 点在 12:00:30（50.0347% 处），属于段内
    const x = (12 * 60 + 0.5) / (24 * 60) * 1000
    fireEvent.pointerDown(track, { clientX: x, pointerId: 1 })
    fireEvent.pointerUp(track, { clientX: x, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledTimes(1)
    const ts = onSeek.mock.calls[0]![0] as number
    expect(Math.abs(ts - (DAY_START + (12 * 60 + 0.5) * 60_000))).toBeLessThan(500)
  })

  it('拖拽过程中指针与一体化时间气泡实时跟随，抬起才 seek', () => {
    const onSeek = vi.fn()
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[seg(0, 24 * 3600, 'all')]}
        playheadTs={null}
        onSeek={onSeek}
        onChangeRange={() => {}}
      />,
    )
    const track = stubTrackRect()
    act(() => {
      fireEvent.pointerDown(track, { clientX: 500, pointerId: 1 })
    })
    // 拖拽中：气泡显示 12:00:00，且尚未 seek
    expect(screen.getByTestId('timeline-playhead-label').textContent).toContain('12:00:00')
    expect(onSeek).not.toHaveBeenCalled()

    act(() => {
      fireEvent.pointerMove(track, { clientX: 750, pointerId: 1 })
    })
    expect(screen.getByTestId('timeline-playhead-label').textContent).toContain('18:00:00')
    expect(onSeek).not.toHaveBeenCalled()

    act(() => {
      fireEvent.pointerUp(track, { clientX: 750, pointerId: 1 })
    })
    expect(onSeek).toHaveBeenCalledTimes(1)
    expect(Math.abs((onSeek.mock.calls[0]![0] as number) - (DAY_START + 18 * 3600_000))).toBeLessThan(500)
  })

  it('时间气泡贴左右边缘时不溢出轨道（竖线仍精确，气泡让位且有三角回指）', () => {
    // 指针在 0.5% 处（5px），直接由 playheadTs 驱动
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[seg(0, 24 * 3600, 'all')]}
        playheadTs={DAY_START + 0.005 * DAY_MS}
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    const line = screen.getByTestId('timeline-playhead')
    const label = screen.getByTestId('timeline-playhead-label')
    // 竖线锚点在 0.5%（精确对准，不被气泡拖累）
    expect(line.style.left).toBe('0.5%')
    // Cross-date label half-width 46px：让位到 32px，相对锚点 shift = 32 - 5 = 27px
    const shift = Number(label.style.left.replace('px', ''))
    expect(shift).toBeGreaterThanOrEqual(40)
    expect(shift).toBeLessThanOrEqual(42)
  })

  it('轨道内容只读：录像块/刻度不接收指针事件，文字不可选中', () => {
    const { container } = render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[seg(600)]}
        playheadTs={null}
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    const track = screen.getByRole('slider', { name: '录像时间轴' })
    expect(track.className).toContain('select-none')
    expect(track.className).toContain('touch-none')
    // 绿块/AI 条/刻度全部 pointer-events-none（事件只能落在轨道本体）
    const interactive = container.querySelectorAll('.bg-success\\/70, .bg-danger\\/40')
    interactive.forEach((el) => expect(el.className).toContain('pointer-events-none'))
  })

  it('指针展示与拖动使用相同的真实时间比例，不人为展宽短片段', () => {
    const segA = seg(12 * 60, 60, 'a') // 12:00:00–12:01:00
    const contiguousB = { ...seg(12 * 60, 60, 'b'), startTs: segA.endTs, endTs: segA.endTs + 60_000 }

    const { rerender } = render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[segA, contiguousB]}
        playheadTs={segA.startTs + 3_000} // 第一段内 5% 处
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    const head = screen.getByTestId('timeline-playhead')
    const posAt5pct = Number.parseFloat(head.style.left)
    expect(posAt5pct).toBeCloseTo(50 + 3_000 / DAY_MS * 100, 5)

    // 全天视图按真实比例推进；精确选择应缩小时间窗口。
    rerender(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[segA, contiguousB]}
        playheadTs={segA.startTs + 57_000}
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    const posAt95pct = Number.parseFloat(screen.getByTestId('timeline-playhead').style.left)
    expect(posAt95pct).toBeCloseTo(50 + 57_000 / DAY_MS * 100, 5)
    expect(posAt95pct - posAt5pct).toBeCloseTo(54_000 / DAY_MS * 100, 5)

    // 跨段仍保持相同比例。
    rerender(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[segA, contiguousB]}
        playheadTs={contiguousB.startTs + 30_000} // 第二段内 50% 处
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    expect(Number.parseFloat(screen.getByTestId('timeline-playhead').style.left)).toBeCloseTo(50.1042, 3)

    // 拖拽和播放展示同一时刻时必须处于同一坐标。
    const track = screen.getByRole('slider', { name: '录像时间轴' })
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 1000, height: 64, right: 1000, bottom: 64,
      toJSON: () => ({}),
    } as DOMRect)
    const targetTs = segA.startTs + 3_000
    const targetClientX = ((targetTs - DAY_START) / DAY_MS) * 1000
    fireEvent.pointerDown(track, { clientX: targetClientX, pointerId: 1 })
    expect(Number.parseFloat(screen.getByTestId('timeline-playhead').style.left)).toBeCloseTo(
      ((targetTs - DAY_START) / DAY_MS) * 100, 3,
    )
    fireEvent.pointerUp(track, { clientX: targetClientX, pointerId: 1 })
  })
})

describe('RecordingTimeline —— 时间范围触发器/弹窗/预设（与识别历史页共用同一套组件）', () => {
  it('触发按钮显示当前窗口范围，点击后打开时间范围弹窗', async () => {
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[]}
        playheadTs={null}
        onSeek={() => {}}
        onChangeRange={() => {}}
      />,
    )
    const trigger = screen.getByTestId('range-trigger')
    expect(trigger.textContent).toContain('09-16 00:00')
    expect(trigger.textContent).toContain('09-17 00:00')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.click(trigger)
    expect(await screen.findByRole('dialog', { name: '选择时间范围' })).toBeInTheDocument()
  })

  it('点击"时"快捷预设——选中态点亮，onChangeRange 拿到毫秒时间戳', async () => {
    const onChangeRange = vi.fn()
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[]}
        playheadTs={null}
        onSeek={() => {}}
        onChangeRange={onChangeRange}
      />,
    )
    const hourBtn = screen.getByRole('button', { name: '时' })
    expect(hourBtn).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(hourBtn)

    expect(hourBtn).toHaveAttribute('aria-pressed', 'true')
    expect(onChangeRange).toHaveBeenCalledTimes(1)
    const [from, to] = onChangeRange.mock.calls[0] as [number, number]
    expect(to - from).toBeCloseTo(60 * 60_000, -2)
  })

  it('弹窗确定后应用新范围、清除预设选中态', async () => {
    const onChangeRange = vi.fn()
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[]}
        playheadTs={null}
        onSeek={() => {}}
        onChangeRange={onChangeRange}
      />,
    )
    // 先点一个预设，确认它会被点亮，再验证弹窗确定后它会熄灭
    await userEvent.click(screen.getByRole('button', { name: '天' }))
    expect(screen.getByRole('button', { name: '天' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByTestId('range-trigger'))
    const fromPanel = await screen.findByTestId('range-picker-from')
    await userEvent.click(within(fromPanel).getByText('00:00'))
    await userEvent.click(screen.getByTestId('range-picker-confirm'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '天' })).toHaveAttribute('aria-pressed', 'false')
    expect(onChangeRange).toHaveBeenCalledTimes(2) // 预设点击一次 + 弹窗确定一次
  })

  it('点击"取消"——关闭弹窗，不调用 onChangeRange', async () => {
    const onChangeRange = vi.fn()
    render(
      <ControlledTimeline
        win={{ from: DAY_START, to: DAY_START + DAY_MS }}
        segments={[]}
        playheadTs={null}
        onSeek={() => {}}
        onChangeRange={onChangeRange}
      />,
    )
    await userEvent.click(screen.getByTestId('range-trigger'))
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByTestId('range-picker-cancel'))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onChangeRange).not.toHaveBeenCalled()
  })
})

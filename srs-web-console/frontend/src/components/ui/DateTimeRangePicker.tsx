import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { WheelPicker, WheelPickerWrapper, type WheelPickerOption } from '@ncdai/react-wheel-picker'
import '@ncdai/react-wheel-picker/style.css'
import {
  formatDurationShort,
  formatRangeFull,
  pad2,
  parseDatetimeLocalValue,
  subtractRangeUnit,
  toDatetimeLocalValue,
  DEFAULT_PRESET,
} from '@/utils/timeRange'

// 2026-09-17：手搓的 WheelColumn（纯 CSS scroll-snap + debounce 吸附）被
// 用户实测吐槽"没有整体滚动动画、跟鼠标拖拽不成比例"——那是因为它压根
// 没有速度追踪/惯性减速物理，只有"停下来后snap"。换成
// @ncdai/react-wheel-picker：MIT、零运行时依赖、peer 兼容 React
// 16.8~19，真正按拖拽速度做 easeOutCubic 惯性减速动画，触屏/鼠标拖拽/
// 鼠标滚轮/键盘都支持。不再自己维护物理引擎。
const HOUR_OPTIONS: WheelPickerOption<number>[] = Array.from({ length: 24 }, (_, n) => ({ value: n, label: pad2(n) }))
const MINUTE_SECOND_OPTIONS: WheelPickerOption<number>[] = Array.from({ length: 60 }, (_, n) => ({ value: n, label: pad2(n) }))

const WHEEL_CLASS_NAMES = {
  optionItem: 'text-sm text-ink-faint',
  highlightItem: 'text-base font-semibold text-primary',
}

interface Props {
  open: boolean
  /** 当前已生效的范围（datetime-local 字符串）——弹窗每次打开都从这里
   * 重新播种草稿态，不保留上次未确认的编辑。 */
  from: string
  to: string
  onConfirm: (from: string, to: string) => void
  onClose: () => void
}

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 6 周固定网格（42 格），周一起头——中文场景的日历习惯。用
 * new Date(y, m, day) 按天数递增而不是 +86400000，跨 DST 也不会错位。 */
function buildDayGrid(viewMonth: Date): Date[] {
  const first = startOfMonth(viewMonth)
  const leadingBlanks = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - leadingBlanks)
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    cells.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
  }
  return cells
}

function withDay(base: Date, day: Date): Date {
  const next = new Date(base)
  next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate())
  return next
}

function withTime(base: Date, hh: number, mm: number, ss: number): Date {
  const next = new Date(base)
  next.setHours(hh, mm, ss, 0)
  return next
}

interface QuickButton {
  label: string
  onClick: () => void
}

interface CalendarPanelProps {
  panelLabel: string
  testId: string
  value: Date
  onChange: (d: Date) => void
  quickButtons: QuickButton[]
}

function CalendarPanel({ panelLabel, testId, value, onChange, quickButtons }: CalendarPanelProps) {
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(value))
  const [mode, setMode] = useState<'days' | 'months'>('days')

  // value 可能被外层的"今天"/"此刻"/quick 按钮整体替换——同步一下月份
  // 游标，否则日历还停在旧月份，看起来像没生效。时分秒不用在这里手动
  // 同步：WheelPicker 自己拿 value 当受控输入，库内部处理动画对齐。
  useEffect(() => {
    setViewMonth(startOfMonth(value))
  }, [value])

  return (
    <div data-testid={testId} className="w-64">
      <p className="mb-2 text-xs font-medium text-ink-subtle">{panelLabel}</p>

      {mode === 'days' ? (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="上个月"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setMode('months')}
              className="rounded-base px-2 py-0.5 text-sm font-medium text-ink hover:bg-surface-page"
            >
              {viewMonth.getFullYear()}年{viewMonth.getMonth() + 1}月
            </button>
            <button
              type="button"
              aria-label="下个月"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink"
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] text-ink-faint">
            {WEEKDAY_LABELS.map((w) => <span key={w} className="py-1">{w}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {buildDayGrid(viewMonth).map((day) => {
              const inMonth = day.getMonth() === viewMonth.getMonth()
              const selected = sameDay(day, value)
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`}
                  onClick={() => onChange(withDay(value, day))}
                  className={[
                    'rounded-base py-1 text-xs transition-colors',
                    selected
                      ? 'bg-primary text-white'
                      : inMonth ? 'text-ink hover:bg-surface-page' : 'text-ink-faint hover:bg-surface-page',
                  ].join(' ')}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="上一年"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear() - 1, m.getMonth(), 1))}
              className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink"
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <span className="text-sm font-medium text-ink">{viewMonth.getFullYear()}年</span>
            <button
              type="button"
              aria-label="下一年"
              onClick={() => setViewMonth((m) => new Date(m.getFullYear() + 1, m.getMonth(), 1))}
              className="rounded-base p-1 text-ink-faint hover:bg-surface-page hover:text-ink"
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {MONTH_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  setViewMonth(new Date(viewMonth.getFullYear(), i, 1))
                  setMode('days')
                }}
                className={[
                  'rounded-base py-2 text-xs transition-colors',
                  i === value.getMonth() && viewMonth.getFullYear() === value.getFullYear()
                    ? 'bg-primary-50 text-primary'
                    : 'text-ink-subtle hover:bg-surface-page hover:text-ink',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* 时/分/秒——iOS 风格滚轮选择器（@ncdai/react-wheel-picker），同一行
       * 放三列，秒本来就放得下，不用为了省空间单独藏起来。三列包进同一个
       * WheelPickerWrapper 共享分组上下文（左右方向键能跨列切）。
       * optionItemHeight=44：Apple HIG 最小触摸目标；visibleCount=4：库
       * 要求必须是 4 的倍数。 */}
      <WheelPickerWrapper className="mt-3 flex items-center justify-center gap-1">
        <div data-testid={`${testId}-hh`} aria-label={`${panelLabel}·小时`}>
          <WheelPicker
            options={HOUR_OPTIONS}
            value={value.getHours()}
            onValueChange={(hh) => onChange(withTime(value, hh, value.getMinutes(), value.getSeconds()))}
            optionItemHeight={44}
            visibleCount={4}
            classNames={WHEEL_CLASS_NAMES}
          />
        </div>
        <span className="text-ink-faint">:</span>
        <div data-testid={`${testId}-mm`} aria-label={`${panelLabel}·分钟`}>
          <WheelPicker
            options={MINUTE_SECOND_OPTIONS}
            value={value.getMinutes()}
            onValueChange={(mm) => onChange(withTime(value, value.getHours(), mm, value.getSeconds()))}
            optionItemHeight={44}
            visibleCount={4}
            classNames={WHEEL_CLASS_NAMES}
          />
        </div>
        <span className="text-ink-faint">:</span>
        <div data-testid={`${testId}-ss`} aria-label={`${panelLabel}·秒`}>
          <WheelPicker
            options={MINUTE_SECOND_OPTIONS}
            value={value.getSeconds()}
            onValueChange={(ss) => onChange(withTime(value, value.getHours(), value.getMinutes(), ss))}
            optionItemHeight={44}
            visibleCount={4}
            classNames={WHEEL_CLASS_NAMES}
          />
        </div>
      </WheelPickerWrapper>

      {quickButtons.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {quickButtons.map((qb) => (
            <button
              key={qb.label}
              type="button"
              onClick={qb.onClick}
              className="rounded-base border border-line px-2 py-1 text-xs text-ink-subtle hover:border-primary hover:text-primary"
            >
              {qb.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 时间范围选择弹窗（识别历史页、录像回放页共用，2026-09-17 从
 * pages/RecognitionHistory/ 提到 components/ui/）——左起始/右结束各一个
 * 独立日历面板（不是首尾联动高亮的一体化范围选择器：那种交互只想改结束
 * 时间时也得先重新点一遍起始，跟这里"两个端点各自独立"的模型对不上）。
 *
 * 草稿态完全封闭在这个组件内：打开时从 props.from/to 播种，编辑只改
 * 草稿，取消/Esc/点遮罩都直接丢弃，只有点"确定"才会把结果通过
 * onConfirm 交回给调用方——调用方决定这算不算"范围变化"，本组件不关心
 * 搜索、不关心预设按钮的选中态，职责只有"选出一对起止时间"。入参/出参
 * 统一用 datetime-local 字符串（'YYYY-MM-DDTHH:mm:ss'），调用方自己决定
 * 内部数值是不是要转成别的表示（比如录像回放页的 win.from/to 是毫秒
 * 时间戳，在调用处转换，不强迫这个组件认识调用方的数据模型）。
 */
export function DateTimeRangePicker({ open, from, to, onConfirm, onClose }: Props) {
  const [draftFrom, setDraftFrom] = useState<Date>(() => new Date())
  const [draftTo, setDraftTo] = useState<Date>(() => new Date())

  useEffect(() => {
    if (!open) return
    const now = new Date()
    setDraftFrom(parseDatetimeLocalValue(from) ?? subtractRangeUnit(now, DEFAULT_PRESET.unit, DEFAULT_PRESET.n))
    setDraftTo(parseDatetimeLocalValue(to) ?? now)
  }, [open, from, to])

  // 只能点「取消」或右上角关闭：点遮罩、误按 Esc 都不关闭，避免已填写的内容白输入

  if (!open) return null

  const invalid = draftFrom.getTime() > draftTo.getTime()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="选择时间范围"
      data-testid="range-picker"
    >
      <div className="flex max-h-[90vh] w-[600px] flex-col overflow-y-auto rounded-panel bg-surface p-6 shadow-modal">
        <h3 className="text-base font-semibold text-ink">选择时间范围</h3>

        <div className="mt-4 flex gap-6">
          <CalendarPanel
            panelLabel="起始时间"
            testId="range-picker-from"
            value={draftFrom}
            onChange={setDraftFrom}
            quickButtons={[
              // "今天"放在最前——用户明确要求："防止选飞了找不到今天日期"，
              // 翻月翻年翻多了，一键回到当前日期（保留已选的时分秒）。
              { label: '今天', onClick: () => setDraftFrom((d) => withDay(d, new Date())) },
              { label: '00:00', onClick: () => setDraftFrom((d) => withTime(d, 0, 0, 0)) },
            ]}
          />
          <div className="w-px shrink-0 bg-line" />
          <CalendarPanel
            panelLabel="结束时间"
            testId="range-picker-to"
            value={draftTo}
            onChange={setDraftTo}
            quickButtons={[
              { label: '今天', onClick: () => setDraftTo((d) => withDay(d, new Date())) },
              { label: '23:59', onClick: () => setDraftTo((d) => withTime(d, 23, 59, 59)) },
              { label: '此刻', onClick: () => setDraftTo(new Date()) },
            ]}
          />
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
          <p className="text-xs text-ink-subtle">
            {invalid ? (
              <span className="text-danger">起始时间不能晚于结束时间</span>
            ) : (
              <>
                {formatRangeFull(draftFrom)} → {formatRangeFull(draftTo)}
                <span className="ml-1.5 text-ink-faint">共 {formatDurationShort(draftTo.getTime() - draftFrom.getTime())}</span>
              </>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              data-testid="range-picker-cancel"
              className="rounded-base border border-line px-4 py-2 text-sm text-ink-subtle hover:bg-surface-page"
            >
              取消
            </button>
            <button
              type="button"
              disabled={invalid}
              onClick={() => {
                onConfirm(toDatetimeLocalValue(draftFrom), toDatetimeLocalValue(draftTo))
                onClose()
              }}
              data-testid="range-picker-confirm"
              className="rounded-base bg-primary px-4 py-2 text-sm text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

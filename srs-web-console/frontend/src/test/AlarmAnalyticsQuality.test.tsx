import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AlarmAnalyticsPage from '@/pages/Analytics/AlarmAnalyticsPage'
import { alarmAnalyticsService, type AlarmAnalyticsQuery, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'

vi.mock('@/api/alarmAnalyticsService', async original => ({
  ...await original<typeof import('@/api/alarmAnalyticsService')>(),
  alarmAnalyticsService: { query: vi.fn() },
}))
vi.mock('@/pages/Analytics/AlarmAnalyticsMap', () => ({ AlarmAnalyticsMap: () => null }))

const from = '2026-10-01T00:00:00.000Z'
const to = '2026-10-02T00:00:00.000Z'
const location = { channel_id: 'processor-a', zone_id: 'entry-a' }
const triggerId = 'trigger-quality-keep-full-stable-identity'
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

function clipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value })
}

function legacyCopy(value: unknown) {
  Object.defineProperty(document, 'execCommand', { configurable: true, value })
}

// Counts are mutually exclusive, as in auditExpression. The 24 human conclusions
// deliberately remain a small, selected subset of the 3,315 recorded alarms.
function resultFor(query: AlarmAnalyticsQuery, counts: {
  pending?: number; confirmed?: number; falsePositive?: number; ai?: number; unknown?: number
} = {}): AlarmAnalyticsResult {
  const pending = counts.pending ?? 1
  const confirmed = counts.confirmed ?? 24
  const falsePositive = counts.falsePositive ?? 0
  const ai = counts.ai ?? 3290
  const unknown = counts.unknown ?? 0
  const human = confirmed + falsePositive
  const total = pending + human + ai + unknown
  return {
    schema_version: '1.0', ...query, as_of: to, total, pending,
    human_confirmed: confirmed, human_false_positive: falsePositive,
    ai_reviewed: ai, unknown_review: unknown,
    trend: [{ from: query.from, to: query.to, total }], zones: [],
    triggers: total ? [{ trigger_id: triggerId, name: '入口危险规则', total, pending,
      human_reviewed: human, human_false_positive: falsePositive, rule_versions: [1, 7] }] : [],
    types: total ? [{ id: 'region_enter', total }] : [],
    week: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => day === 0 && hour === 9 ? total : 0)),
    quality: {
      human_reviewed: human, false_positive_ratio: human ? falsePositive / human : null,
      wait: { samples: human, median_ms: human ? 6120000 : null, p90_ms: human ? 6480000 : null, unknown: 0 },
      pending_age: { lt10m: 0, lt1h: 0, gte1h: pending },
    },
    association: { unassociated: 0 },
    catalog: { zones: [{ ...location, name: '入口' }], triggers: [{ trigger_id: triggerId, name: '入口危险规则' }], types: ['region_enter'] },
    consistency: 'non_transactional', coverage: 'unknown', issues: [],
  }
}

function mount(extra = '') {
  return render(<MemoryRouter initialEntries={[
    '/analytics?subject=alarms&alarm_tab=quality&range=custom&from=' + from + '&to=' + to + '&compare=0' + extra,
  ]}><AlarmAnalyticsPage /></MemoryRouter>)
}

function drillScope(element: HTMLElement) {
  const href = element.getAttribute('href')!
  return JSON.parse(new URL(href, 'http://localhost').searchParams.get('analytics_scope')!) as AlarmAnalyticsQuery
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => resultFor(query))
})

afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor)
  else Reflect.deleteProperty(document, 'execCommand')
  vi.unstubAllGlobals()
})

it('uses quality-specific KPIs and explicit denominators despite 3290 AI versus 24 human conclusions', async () => {
  mount()
  const human = await screen.findByRole('region', { name: '人工明确结论' })
  expect(human).toHaveTextContent('24')
  expect(human).toHaveTextContent(/3,315|3315/)
  expect(human).toHaveTextContent('0.7%')
  const falsePositive = screen.getByRole('region', { name: '人工样本误报占比' })
  expect(falsePositive).toHaveTextContent('0.0%')
  expect(falsePositive).toHaveTextContent(/0\s*\/\s*24/)
  expect(screen.getByRole('region', { name: '发生至首次人工审核' })).toHaveTextContent('1.7 小时')
  expect(screen.getByRole('region', { name: '至少 1 小时待审核' })).toHaveTextContent('1')
  const subjects = screen.getByRole('region', { name: '审核主体分布' })
  expect(subjects).toHaveTextContent(/3,315|3315/)
  expect(subjects).toHaveTextContent('3,290')
  const conclusions = screen.getByRole('region', { name: '人工结论分布' })
  expect(conclusions).toHaveTextContent('24')
  expect(conclusions).not.toHaveTextContent('3,290')
  expect(screen.queryByRole('link', { name: '范围内新增告警 3315条' })).not.toBeInTheDocument()
})

it('shows no percentage or duration estimate with no observations rather than NaN, infinity or a false zero rate', async () => {
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => resultFor(query, {
    pending: 0, confirmed: 0, falsePositive: 0, ai: 0, unknown: 0,
  }))
  mount()
  const human = await screen.findByRole('region', { name: '人工明确结论' })
  expect(human).toHaveTextContent('0')
  expect(human).not.toHaveTextContent(/\d+(?:\.\d+)?%/)
  const ratio = screen.getByRole('region', { name: '人工样本误报占比' })
  expect(ratio).toHaveTextContent('—')
  expect(ratio).not.toHaveTextContent(/\d+(?:\.\d+)?%/)
  const wait = screen.getByRole('region', { name: '发生至首次人工审核' })
  expect(wait).toHaveTextContent('—')
  expect(wait).toHaveTextContent(/有效样本\s*0/)
  expect(screen.getByRole('main')).not.toHaveTextContent(/NaN|Infinity/)
  expect(screen.getByText(/当前范围已记录 0 条告警/)).toHaveTextContent('不能据此判断没有异常')
})

it('keeps unknown review records out of human denominators when all other conclusions are AI', async () => {
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => resultFor(query, {
    pending: 0, confirmed: 0, falsePositive: 0, ai: 3290, unknown: 25,
  }))
  mount()
  const ratio = await screen.findByRole('region', { name: '人工样本误报占比' })
  expect(ratio).toHaveTextContent('—')
  expect(ratio).not.toHaveTextContent('0.0%')
  expect(screen.getByRole('region', { name: '人工明确结论' })).toHaveTextContent('0.0%')
  const unknown = within(screen.getByRole('region', { name: '审核主体分布' })).getByRole('link', { name: /未知/ })
  expect(unknown).toHaveTextContent('25')
  expect(drillScope(unknown)).toMatchObject({ audit: 'unknown' })
  expect(screen.getByRole('region', { name: '人工结论分布' })).not.toHaveTextContent('25')
})

it('computes human-sample error share against explicit human conclusions, independently of total or AI', async () => {
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => resultFor(query, {
    pending: 1, confirmed: 3, falsePositive: 1, ai: 3290, unknown: 25,
  }))
  mount()
  const ratio = await screen.findByRole('region', { name: '人工样本误报占比' })
  expect(ratio).toHaveTextContent('25.0%')
  expect(ratio).toHaveTextContent(/1\s*\/\s*4/)
  const conclusions = screen.getByRole('region', { name: '人工结论分布' })
  expect(within(conclusions).getByRole('link', { name: /人工确认/ })).toHaveTextContent('3')
  expect(within(conclusions).getByRole('link', { name: /人工判为误报/ })).toHaveTextContent('1')
  expect(conclusions).not.toHaveTextContent('3,290')
})

it('retains the non-random-sample and non-AI-accuracy caveats even after 20 human conclusions', async () => {
  mount()
  const ratio = await screen.findByRole('region', { name: '人工样本误报占比' })
  expect(screen.getByRole('main')).toHaveTextContent(/非随机|不是随机/)
  expect(screen.getByRole('main')).toHaveTextContent(/非\s*AI\s*准确率|不是\s*AI\s*准确率/)
  // Decisive caveats remain visible while explanatory details stay collapsed.
  for (const node of within(ratio).getAllByText(/非随机|不是随机|非\s*AI\s*准确率|不是\s*AI\s*准确率/)) {
    expect(node.closest('details')).toBeNull()
  }
  const notes = screen.getByText('统计说明').closest('details')!
  expect(notes).not.toHaveAttribute('open')
})

it('uses valid timing samples instead of all human conclusions and distinguishes missing durations', async () => {
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => {
    const result = resultFor(query)
    result.quality.wait = { samples: 4, unknown: 20, median_ms: 90000, p90_ms: 3600000 }
    return result
  })
  mount()
  const wait = await screen.findByRole('region', { name: '发生至首次人工审核' })
  expect(wait).toHaveTextContent('1.5 分钟')
  expect(wait).toHaveTextContent(/有效样本\s*4/)
  expect(wait).not.toHaveTextContent(/有效样本\s*24/)
  expect(wait).toHaveTextContent(/非处置完成|不是处置完成/)
  const summary = screen.getByText('统计说明')
  fireEvent.click(summary)
  expect(summary.closest('details')).toHaveTextContent(/无可靠时长\s*20/)
})

it('leaves duration unknown when human conclusions exist but no reliable timing sample does', async () => {
  vi.mocked(alarmAnalyticsService.query).mockImplementation(async query => {
    const result = resultFor(query)
    result.quality.wait = { samples: 0, unknown: 24, median_ms: null, p90_ms: null }
    return result
  })
  mount()
  const wait = await screen.findByRole('region', { name: '发生至首次人工审核' })
  expect(wait).toHaveTextContent('—')
  expect(wait).toHaveTextContent(/有效样本\s*0/)
  expect(wait).not.toHaveTextContent(/0(?:\.0)?\s*(分钟|小时|秒)/)
  const summary = screen.getByText('统计说明')
  fireEvent.click(summary)
  expect(summary.closest('details')).toHaveTextContent(/无可靠时长\s*24/)
})

it('preserves every supported filter in quality links and never invents pending-age drilldown', async () => {
  mount('&alarm_locations=' + encodeURIComponent(JSON.stringify([location])) + '&trigger_id=' + triggerId + '&primary_type=region_enter')
  await screen.findByRole('region', { name: '人工明确结论' })
  const expected = { from, to, locations: [location], trigger_id: triggerId, primary_type: 'region_enter' }
  const subjects = screen.getByRole('region', { name: '审核主体分布' })
  const conclusions = screen.getByRole('region', { name: '人工结论分布' })
  for (const panel of [subjects, conclusions]) {
    for (const link of within(panel).getAllByRole('link')) expect(drillScope(link)).toMatchObject(expected)
  }
  expect(drillScope(within(conclusions).getByRole('link', { name: /人工确认/ }))).toMatchObject({ ...expected, audit: 'human_confirmed' })
  expect(drillScope(within(conclusions).getByRole('link', { name: /人工判为误报/ }))).toMatchObject({ ...expected, audit: 'human_false_positive' })
  const ages = screen.getByRole('region', { name: '当前待审核年龄' })
  expect(within(ages).queryByRole('link', { name: /至少 1 小时|不足 10 分钟|10 分钟—1 小时/ })).not.toBeInTheDocument()
  expect(within(ages).queryByRole('button')).not.toBeInTheDocument()
  const pending = within(ages).getByRole('link', { name: '查看全部待审核' })
  expect(drillScope(pending)).toEqual({ ...vi.mocked(alarmAnalyticsService.query).mock.calls[0]![0], audit: 'pending' })
  expect(ages).not.toHaveTextContent(/SLA|超时/)
  const rank = screen.getByRole('table', { name: '规则审核质量排名' })
  const falsePositive = within(rank).getByRole('link', { name: /0\s*\/\s*24/ })
  expect(drillScope(falsePositive)).toMatchObject({ ...expected, audit: 'human_false_positive' })
})

it('offers full rule identity and recorded versions in expandable details with an explicit copy action', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  clipboard({ writeText })
  mount()
  const rank = await screen.findByRole('table', { name: '规则审核质量排名' })
  const summary = within(rank).getByText('规则详情')
  const details = summary.closest('details')!
  expect(details).not.toHaveAttribute('open')
  fireEvent.click(summary)
  expect(details).toHaveAttribute('open')
  expect(within(details).getByText(triggerId, { exact: true })).toBeVisible()
  expect(details).toHaveTextContent(/执行版本.*1.*7/)
  await act(async () => { fireEvent.click(within(details).getByRole('button', { name: /复制规则编号/ })) })
  expect(writeText).toHaveBeenCalledWith(triggerId)
  expect(screen.getByRole('status')).toHaveTextContent('已复制规则编号')
})

it('copies the complete ID on HTTP without Clipboard API, removes the temporary input and restores focus', async () => {
  vi.stubGlobal('isSecureContext', false)
  clipboard(undefined)
  const copy = vi.fn(() => {
    const input = document.querySelector('textarea')!
    expect(input.value).toBe(triggerId)
    expect(input.readOnly).toBe(true)
    return true
  })
  legacyCopy(copy)
  mount()
  const rank = await screen.findByRole('table', { name: '规则审核质量排名' })
  fireEvent.click(within(rank).getByText('规则详情'))
  const button = within(rank).getByRole('button', { name: /复制规则编号/ })
  button.focus()
  await act(async () => { fireEvent.click(button) })
  expect(copy).toHaveBeenCalledWith('copy')
  expect(screen.getByRole('status')).toHaveTextContent('已复制规则编号')
  expect(document.querySelector('textarea')).toBeNull()
  expect(button).toHaveFocus()
})

it('falls back when modern clipboard permissions are denied instead of reporting success prematurely', async () => {
  const writeText = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
  const copy = vi.fn().mockReturnValue(true)
  clipboard({ writeText })
  legacyCopy(copy)
  mount()
  const rank = await screen.findByRole('table', { name: '规则审核质量排名' })
  fireEvent.click(within(rank).getByText('规则详情'))
  await act(async () => { fireEvent.click(within(rank).getByRole('button', { name: /复制规则编号/ })) })
  expect(writeText).toHaveBeenCalledWith(triggerId)
  expect(copy).toHaveBeenCalledWith('copy')
  expect(screen.getByRole('status')).toHaveTextContent('已复制规则编号')
  expect(document.querySelector('textarea')).toBeNull()
})

it.each(['returns false', 'throws', 'is absent'])('reports an actionable copy failure when modern API is unavailable and legacy copy %s', async mode => {
  vi.stubGlobal('isSecureContext', false)
  clipboard(undefined)
  legacyCopy(mode === 'is absent' ? undefined : vi.fn(() => {
    if (mode === 'throws') throw new Error('copy unsupported')
    return false
  }))
  mount()
  const rank = await screen.findByRole('table', { name: '规则审核质量排名' })
  fireEvent.click(within(rank).getByText('规则详情'))
  const button = within(rank).getByRole('button', { name: /复制规则编号/ })
  button.focus()
  await act(async () => { fireEvent.click(button) })
  expect(screen.getByRole('status')).toHaveTextContent('未能自动复制')
  expect(screen.getByRole('status')).toHaveTextContent('选中下方规则编号复制')
  expect(screen.getByRole('status')).not.toHaveTextContent('已复制规则编号')
  expect(within(rank).getByText(triggerId, { exact: true })).toBeVisible()
  expect(document.querySelector('textarea')).toBeNull()
  expect(button).toHaveFocus()
})

import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { alarmAnalyticsHref, type AlarmAnalyticsQuery, type AlarmAnalyticsResult } from '@/api/alarmAnalyticsService'

const count = (value: number) => value.toLocaleString('zh-CN')
const percent = (n: number, denominator: number) => denominator ? `${(n / denominator * 100).toFixed(1)}%` : '—'
const duration = (ms: number | null) => ms === null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} 秒` : ms < 3600000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${(ms / 3600000).toFixed(1)} 小时`
const linkClass = 'inline-flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center text-primary underline underline-offset-2 focus-visible:outline-primary'

export function QualityKpis({ result, query }: { result: AlarmAnalyticsResult; query: AlarmAnalyticsQuery }) {
  const q = result.quality
  return <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="审核质量关键指标">
    <section className="ui-panel min-w-0 px-3 py-2" aria-label="人工明确结论">
      <h2 className="text-xs text-ink-subtle">人工明确结论</h2>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{count(q.human_reviewed)}<span className="ml-1 text-xs font-normal text-ink-subtle">/ {count(result.total)} 条</span></p>
      <p className="mt-1 text-xs text-ink-subtle">占范围告警 {percent(q.human_reviewed, result.total)} · 非随机样本</p>
    </section>
    <section className="ui-panel min-w-0 px-3 py-2" aria-label="人工样本误报占比">
      <h2 className="text-xs text-ink-subtle">人工样本误报占比</h2>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{percent(result.human_false_positive, q.human_reviewed)}<Link className={linkClass + ' ml-2 text-xs font-normal'} to={alarmAnalyticsHref({ ...query, audit: 'human_false_positive' })}>{count(result.human_false_positive)} / {count(q.human_reviewed)} 条</Link></p>
      <p className="mt-1 text-xs text-ink-subtle">选择性人工样本 · 非 AI 准确率</p>
    </section>
    <section className="ui-panel min-w-0 px-3 py-2" aria-label="发生至首次人工审核">
      <h2 className="text-xs text-ink-subtle">发生至首次人工审核 · 中位数</h2>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{duration(q.wait.median_ms)}</p>
      <p className="mt-1 text-xs text-ink-subtle">有效样本 {count(q.wait.samples)} · 非处置完成</p>
    </section>
    <section className={'ui-panel min-w-0 px-3 py-2 ' + (q.pending_age.gte1h > 0 ? '!border-amber-200 !bg-amber-50/50' : '')} aria-label="至少 1 小时待审核">
      <h2 className="text-xs text-ink-subtle">至少 1 小时待审核</h2>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{count(q.pending_age.gte1h)}<span className="ml-1 text-xs font-normal text-ink-subtle">条</span></p>
      <p className="mt-1 text-xs text-ink-subtle">所选发生时段 · 未设业务时限</p>
    </section>
  </div>
}

export default function AlarmAnalyticsQuality({ result, query, ranking }: { result: AlarmAnalyticsResult; query: AlarmAnalyticsQuery; ranking?: ReactNode }) {
  const q = result.quality
  const subjects = [
    { label: 'AI 已审核', n: result.ai_reviewed, audit: 'ai_reviewed' as const, color: 'bg-slate-400' },
    { label: '人工明确结论', n: q.human_reviewed, color: 'bg-primary' },
    { label: '待审核', n: result.pending, audit: 'pending' as const, color: 'bg-amber-400' },
    { label: '审核主体/结论未知', n: result.unknown_review, audit: 'unknown' as const, color: 'bg-slate-300' },
  ]
  return <div className="grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)]">
    <div className="ui-panel min-w-0 p-3">
      <section aria-label="审核主体分布">
        <header className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2"><h2 className="text-sm font-semibold text-ink">审核主体分布</h2><span className="text-xs text-ink-subtle">分母：全部告警 {count(result.total)} 条</span></header>
        <div>{subjects.map(row => {
          const content = <><span className="truncate">{row.label}</span><span className="h-2 overflow-hidden rounded bg-surface-page" aria-hidden="true"><span className={'block h-full rounded ' + row.color} style={{ width: `${result.total ? row.n / result.total * 100 : 0}%` }} /></span><span className="text-right tabular-nums">{count(row.n)}</span><span className="text-right tabular-nums text-ink-subtle">{percent(row.n, result.total)}</span></>
          const rowClass = 'grid min-h-8 [@media(pointer:coarse)]:min-h-11 grid-cols-[8rem_minmax(0,1fr)_3.5rem_3.5rem] items-center gap-2 text-xs'
          return row.audit ? <Link key={row.label} className={rowClass + ' text-ink hover:text-primary focus-visible:outline-primary'} to={alarmAnalyticsHref({ ...query, audit: row.audit })}>{content}</Link> : <div key={row.label} className={rowClass + ' text-ink'}>{content}</div>
        })}</div>
      </section>
      <section className="mt-3 border-t border-line pt-3" aria-label="人工结论分布">
        <header className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2"><h2 className="text-sm font-semibold text-ink">人工结论分布</h2><span className="text-xs text-ink-subtle">分母：人工明确结论 {count(q.human_reviewed)} 条</span></header>
        <div className="grid grid-cols-2 gap-2">{([
          ['human_confirmed', '人工确认', result.human_confirmed],
          ['human_false_positive', '人工判为误报', result.human_false_positive],
        ] as const).map(([audit, label, n]) => <Link key={audit} className="rounded-lg border border-line px-3 py-2 text-ink hover:border-primary focus-visible:outline-primary" to={alarmAnalyticsHref({ ...query, audit })}><span className="block text-xs text-ink-subtle">{label}</span><span className="mt-1 flex flex-wrap items-baseline gap-x-2"><strong className="text-lg font-semibold tabular-nums">{count(n)}<span className="ml-1 text-xs font-normal">条</span></strong><span className="text-xs tabular-nums text-ink-subtle">{percent(n, q.human_reviewed)}</span></span></Link>)}</div>
        <p className="mt-2 text-xs text-ink-subtle">{q.human_reviewed === 0 ? '暂无人工明确结论，暂不计算占比。' : q.human_reviewed < 20 ? '样本少，不作优劣比较；选择性样本不代表全部告警。' : '选择性样本不代表全部告警，不能据此评价 AI 准确率。'}</p>
      </section>
    </div>
    <div className="flex min-w-0 flex-col gap-3">
      <section className="ui-panel min-w-0 p-3" aria-label="规则审核质量">
        <header className="mb-1 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold text-ink">规则审核质量</h2><span className="text-xs text-ink-subtle">按人工误报数量排序 · 分项可交叉</span></header>
        {ranking}
        <p className="mt-1 text-xs text-ink-subtle">分母为每条规则的人工明确结论，样本非随机。</p>
      </section>
      <section className="ui-panel min-w-0 p-3" aria-label="当前待审核年龄">
        <header className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">当前待审核年龄</h2><Link className={linkClass + ' text-xs'} to={alarmAnalyticsHref({ ...query, audit: 'pending' })}>查看全部待审核</Link></header>
        <div className="grid grid-cols-3 gap-2">{[['不足 10 分钟', q.pending_age.lt10m], ['10 分钟—1 小时', q.pending_age.lt1h], ['至少 1 小时', q.pending_age.gte1h]].map(([label, n]) => <div key={label} className={'rounded-lg px-2 py-2 ' + (Number(n) > 0 ? 'bg-amber-50' : 'bg-surface-page')}><p className="text-xs text-ink-subtle">{label}</p><strong className="mt-1 block text-lg font-semibold tabular-nums text-ink">{count(Number(n))}</strong></div>)}</div>
        <p className="mt-2 text-xs text-ink-subtle">年龄分桶仅展示；链接查看当前范围全部待审核。</p>
      </section>
    </div>
  </div>
}

export function QualityNotes({ result }: { result: AlarmAnalyticsResult }) {
  const q = result.quality
  return <>
    <p className="mt-2 max-w-3xl">发生至首次人工审核从发生时间起算，包含采集入库延迟；仅含已人工审核的有效样本，未审核记录不参与。不是响应速度或处置完成时长。有效样本 {count(q.wait.samples)}{q.wait.samples < 20 ? ' · 样本少，仅供参考' : ''}；无可靠时长 {count(q.wait.unknown)}；P90 {duration(q.wait.p90_ms)}。</p>
    <p className="mt-2 max-w-3xl">待审核年龄从发生至本次查询截止计算，仅含所选发生时段内当前待审核告警，不是历史积压快照；1 小时只是展示分组边界，未配置业务 SLA。AI 与人工按当前状态互斥归类，人工可改判 AI；阶段升级可能重新打开审核，不构成线性漏斗。</p>
    <p className="mt-2 max-w-3xl">人工误报占比的分母仅为人工明确结论，样本存在选择偏差。样本数量增加不能消除非随机抽样偏差，不能用于推算 AI 总体误报率或漏报率。</p>
  </>
}

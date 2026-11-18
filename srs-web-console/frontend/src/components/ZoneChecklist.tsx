import { useState, type ReactNode } from 'react'

export interface ZoneOption {
  key: string
  name: string
  /** The channel it belongs to: zones of different channels may share a name. */
  group?: string
  /** Said after the name, e.g. that the location is no longer bound. */
  note?: string
}

interface Props {
  /** The group's accessible name, e.g. "门口闯入 的热区". */
  label: string
  hint: string
  options: ZoneOption[]
  chosen: ReadonlySet<string>
  /** The new choice; every option means "all". Never empty. */
  onChange: (keys: string[]) => void
  /** Numbers or actions at the end of a row, and anything under it. */
  extra?: (option: ZoneOption, checked: boolean) => ReactNode
  /** Zones chosen somewhere else (a drill-down, an older binding) that this card does not list. */
  outside?: { count: number; clear: () => void }
  limit?: number
}

const small = 'inline-flex min-h-9 shrink-0 items-center rounded-base px-2 text-xs text-primary hover:bg-primary-50 [@media(pointer:coarse)]:min-h-11'

/**
 * The zones of one statistic or alarm rule, chosen on its own card: tick several, "只看" one, or 全选. The last ticked zone
 * stays ticked, because an empty choice would quietly mean every zone again. Long lists show six and fold the rest, as the
 * column already scrolls (a scroll inside a scroll is hard on touch).
 */
export function ZoneChecklist({ label, hint, options, chosen, onChange, extra, outside, limit = 6 }: Props) {
  const [open, setOpen] = useState(false)
  const picked = options.filter(o => chosen.has(o.key))
  const count = picked.length
  const shown = open ? options : options.slice(0, limit)
  const set = (keys: Set<string>) => onChange(options.filter(o => keys.has(o.key)).map(o => o.key))
  const toggle = (key: string) => { const next = new Set(picked.map(o => o.key)); if (next.has(key)) next.delete(key); else next.add(key); if (next.size) set(next) }
  let lastGroup: string | undefined
  return <div role="group" aria-label={label} className="space-y-1">
    <div className="flex min-h-9 items-center gap-2 text-xs text-ink-subtle [@media(pointer:coarse)]:min-h-11">
      <span className="min-w-0 truncate">{hint}</span>
      <span className="ml-auto shrink-0 tabular-nums">已选 {count} / {options.length}</span>
      {count < options.length && <button type="button" className={small} onClick={() => onChange(options.map(o => o.key))}>全选</button>}
    </div>
    <ul className="divide-y divide-line rounded-base border border-line">
      {shown.map(o => {
        const checked = chosen.has(o.key)
        const heading = o.group !== undefined && o.group !== lastGroup
        lastGroup = o.group
        return <li key={o.key} className="px-2">
          {heading && <p className="truncate pt-1.5 text-xs text-ink-faint" title={o.group}>{o.group}</p>}
          <div className="flex flex-wrap items-center gap-x-1">
            <label className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-ink [@media(pointer:coarse)]:min-h-11" title={checked && count === 1 ? '至少保留一个；要看全部请点全选' : undefined}>
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={checked} disabled={checked && count === 1} aria-label={o.name} onChange={() => toggle(o.key)} />
              <span className="min-w-0 truncate" title={o.note ? `${o.name}（${o.note}）` : o.name}>{o.name}{o.note && <span className="text-ink-faint">（{o.note}）</span>}</span>
            </label>
            {!(checked && count === 1) && <button type="button" className={small} aria-label={`只看 ${o.name}`} onClick={() => onChange([o.key])}>只看</button>}
            {extra?.(o, checked)}
          </div>
        </li>
      })}
    </ul>
    {options.length > limit && <button type="button" className={small} aria-label={open ? '收起' : `展开其余 ${options.length - limit} 个`} onClick={() => setOpen(v => !v)}>{open ? '收起' : `展开其余 ${options.length - limit} 个`}</button>}
    {outside && outside.count > 0 && <p className="flex items-center gap-2 px-1 text-xs text-ink-subtle">另有 {outside.count} 个已选位置不在本卡<button type="button" className={small} aria-label="清除其他已选位置" onClick={outside.clear}>清除</button></p>}
  </div>
}

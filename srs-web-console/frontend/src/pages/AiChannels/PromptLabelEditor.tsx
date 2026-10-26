import { useRef, useState } from 'react'
import type { AiPromptLabel } from '@/types/aiChannel'

interface Props {
  context?: 'channel' | 'trigger'
  rows: AiPromptLabel[]
  limit: number
  error?: string
  onChange: (rows: AiPromptLabel[]) => void
}

export function PromptLabelEditor({ rows, limit, error, onChange, context = 'channel' }: Props) {
  const [removed, setRemoved] = useState<{row: AiPromptLabel; index: number} | null>(null)
  const [search, setSearch] = useState('')
  const query=search.trim().toLocaleLowerCase()
  const visible=rows.map((row,index)=>({row,index})).filter(({row})=>
    !query || [row.description,row.label_id,row.label_name].some(value=>value.toLocaleLowerCase().includes(query)))
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const update = (index: number, field: keyof AiPromptLabel, value: string) =>
    onChange(rows.map((row, i) => i === index ? {...row, [field]: value} : row))
  return <section aria-label="识别标签配置" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">识别标签 <span className="text-sm text-ink-subtle">{rows.length} / {limit}</span></h3>
      <button type="button" disabled={rows.length >= limit} className="min-h-11 rounded-base border border-line px-3 text-primary disabled:opacity-40"
        onClick={() => {
          setSearch('')
          onChange([...rows, {description:'', label_id:'', label_name:''}])
          requestAnimationFrame(() => inputs.current[rows.length]?.focus())
        }}>＋ 添加标签</button>
    </div>
    <p className="text-xs text-ink-faint">{context==='trigger'?'每行一个监控目标，任一目标命中均可触发。识别描述、标签 ID 和名称须与 AI 通道一致。':'每行一个识别类别，可同时检测多个目标。描述建议英文；标签名称用于显示，标签 ID 用于历史检索，修改名称不会改变 ID。'}</p>
    <label className="block text-sm">查找标签
      <input type="search" aria-label="查找标签" placeholder="描述、标签 ID 或名称" value={search}
        onChange={event=>setSearch(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-base border border-line bg-surface px-3" />
    </label>
    {query && <p role="status" className="text-xs text-ink-subtle">找到 {visible.length} / {rows.length} 项；筛选不会改变配置。</p>}
    <div className="space-y-3">
      {visible.map(({row, index}) => <fieldset key={index} className="rounded-base border border-line p-3">
        <legend className="px-1 text-xs text-ink-subtle">标签 {index+1}</legend>
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          {([['description','识别描述',160],['label_id','标签 ID',64],['label_name','标签名称',64]] as const).map(([field,label,length]) =>
            <label key={field} className="min-w-0 text-sm">{label}
              <input ref={field==='description' ? el => {inputs.current[index]=el} : undefined}
                aria-label={`${label} ${index+1}`} value={row[field]} maxLength={length} spellCheck={false}
                autoCapitalize={field==='label_id' ? 'none' : undefined}
                onChange={event=>update(index,field,event.target.value)}
                className="mt-1.5 min-h-11 w-full rounded-base border border-line bg-surface px-3 py-2 outline-none focus:border-primary" />
            </label>)}
          <button type="button" aria-label={`删除标签 ${index+1}`} disabled={rows.length<=1}
            className="min-h-11 rounded-base border border-line px-3 text-danger disabled:opacity-40 md:mt-6"
            onClick={()=>{setRemoved({row:{...row},index});onChange(rows.filter((_,i)=>i!==index))}}>删除</button>
        </div>
      </fieldset>)}
    </div>
    {removed && <div role="status" className="flex items-center gap-3 text-sm">
      已删除“{removed.row.label_name || removed.row.description || '空标签'}”
      <button type="button" disabled={rows.length>=limit} className="min-h-11 px-3 text-primary disabled:opacity-40"
        onClick={()=>{const next=[...rows];next.splice(Math.min(removed.index,next.length),0,removed.row);onChange(next);setRemoved(null)}}>撤销删除</button>
    </div>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <p className="text-xs text-ink-faint">{context==='trigger'?'这里只定义告警监控目标，不会修改 AI 通道的识别配置。请先在对应 AI 通道配置相同标签，再关联触发器。':'更改在“保存修改”后生效，会重新载入通道；无需重编模型。删除标签不会删除已有识别记录。切换到较小模型时不会自动丢弃标签。'}</p>
  </section>
}

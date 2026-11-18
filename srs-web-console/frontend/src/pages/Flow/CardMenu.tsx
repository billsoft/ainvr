import { MoreHorizontal, type LucideIcon } from 'lucide-react'
import { useRef, useState } from 'react'

export interface CardMenuItem { label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean }

/** Low-frequency actions of one card, out of the way of the numbers: same pattern as the alarm list's "更多操作". */
export function CardMenu({ label, items }: { label: string; items: CardMenuItem[] }) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  return <div className="relative shrink-0" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
      className="inline-flex !min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-hover hover:text-ink"><MoreHorizontal size={18} aria-hidden="true" /></button>
    {open && <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-40 rounded-panel border border-line bg-surface p-1 shadow-lg">
      {items.map(({ label: name, icon: Icon, onSelect, danger, disabled }) => <button key={name} role="menuitem" type="button" disabled={disabled}
        onClick={() => { setOpen(false); trigger.current?.focus(); onSelect() }}
        className={`flex !min-h-11 w-full items-center gap-2 rounded-base px-3 text-left text-sm disabled:opacity-50 ${danger ? 'text-danger-700 hover:bg-danger-50' : 'text-ink hover:bg-surface-hover'}`}>
        <Icon size={16} aria-hidden="true" />{name}</button>)}
    </div>}
  </div>
}

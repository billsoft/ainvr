import type { ReactNode } from 'react'

export const inputCls = 'form-input'

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="ui-panel space-y-4 p-4 sm:p-5">
    <div><h3 className="text-sm font-semibold text-ink">{title}</h3>{hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}</div>
    {children}
  </section>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-xs font-medium text-ink">{label}</span>{children}
    {hint && <span className="mt-1.5 block text-xs text-ink-subtle">{hint}</span>}
  </label>
}

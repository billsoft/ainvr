import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useMatch } from 'react-router-dom'
import { PanelRightClose } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useSideColumn } from './useSideColumn'

interface Props {
  /** Name of the menu entry; also labels the tab strip. */
  label: string
  tabs: { to: string; name: string }[]
  /** Address that means "the side column is wanted" (and is the second tab when there is no room). */
  sideRoute: string
  storageKey: string
  /** Narrowest the middle may get while the column is docked. */
  middleMin: number
  sideTitle: string
  sideIcon: LucideIcon
  middle: ReactNode
  side: ReactNode
  /** Told whether the docked column is currently open. */
  onOpenChange?: (open: boolean) => void
}

/**
 * Middle content with a collapsible column on its right (like the playback page); on a page too narrow
 * for both it falls back to two tabs. Both parts stay mounted in either mode — only what is shown
 * changes — so resizing across the threshold keeps loaded data, filters and open dialogs.
 */
export function SideDockedSection({ label, tabs, sideRoute, storageKey, middleMin, sideTitle, sideIcon: Icon, middle, side, onOpenChange }: Props) {
  const onSideRoute = !!useMatch({ path: sideRoute, end: true })
  const { hostRef, docked, open, toggle } = useSideColumn({ storageKey, middleMin, requested: onSideRoute })
  const showSide = docked ? open : onSideRoute
  const [mounted, setMounted] = useState(showSide)
  if (showSide && !mounted) setMounted(true)
  useEffect(() => onOpenChange?.(docked && open), [docked, open, onOpenChange])

  return (
    <div ref={hostRef} className="flex h-full min-h-0 flex-col">
      {!docked && (
        <nav aria-label={label} className="flex shrink-0 gap-1 border-b border-line bg-surface px-3 sm:px-4">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end
              className={({ isActive }) =>
                `-mb-px shrink-0 border-b-2 px-4 py-2 text-sm [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-3 ${
                  isActive ? 'border-primary font-medium text-primary' : 'border-transparent text-ink-subtle hover:text-ink'
                }`
              }
            >
              {t.name}
            </NavLink>
          ))}
        </nav>
      )}
      <div className={`flex min-h-0 flex-1 ${docked ? 'gap-4' : ''}`}>
        <div hidden={!docked && onSideRoute} className="min-h-0 min-w-0 flex-1 overflow-y-auto [container-type:inline-size] [&[hidden]]:hidden">
          {middle}
        </div>
        {mounted && (
          <aside
            aria-label={sideTitle}
            hidden={!showSide}
            className={`flex min-h-0 flex-col [container-type:inline-size] [&[hidden]]:hidden ${
              docked ? 'w-[380px] shrink-0 overflow-hidden rounded-panel border border-line bg-surface' : 'min-w-0 flex-1 overflow-y-auto'
            }`}
          >
            {docked && (
              <div className="flex shrink-0 items-center justify-between border-b border-line px-3">
                <h2 className="flex items-center gap-2 font-semibold text-ink"><Icon size={16} aria-hidden="true" />{sideTitle}</h2>
                <button type="button" aria-label={`收起${sideTitle}`} title={`收起${sideTitle}`} onClick={toggle}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-base text-ink-subtle hover:bg-surface-page hover:text-primary">
                  <PanelRightClose size={18} />
                </button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">{side}</div>
          </aside>
        )}
        {docked && !open && (
          <button type="button" aria-label={sideTitle} aria-pressed={false} title={`展开${sideTitle}`} onClick={toggle}
            className="flex w-11 shrink-0 flex-col items-center gap-3 rounded-panel border border-line bg-surface py-3 text-ink-subtle hover:text-primary">
            <Icon size={18} aria-hidden="true" />
            <span className="text-xs font-medium [writing-mode:vertical-rl]">{sideTitle}</span>
          </button>
        )}
      </div>
    </div>
  )
}

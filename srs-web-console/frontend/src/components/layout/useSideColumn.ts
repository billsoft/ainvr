import { useLayoutEffect, useRef, useState } from 'react'

/** Width of the right-hand column and the gap before it; the middle keeps at least `middleMin`. */
export const SIDE_WIDTH = 380
export const SIDE_GAP = 16
/** Extra room beyond the minimum before the column opens by itself, for someone who never chose. */
const COMFORT = 160

export function sideFits(hostWidth: number, middleMin: number) {
  return hostWidth >= SIDE_WIDTH + SIDE_GAP + middleMin
}

function read(key: string): boolean | undefined {
  try { const v = localStorage.getItem(key); return v === 'open' ? true : v === 'closed' ? false : undefined } catch { return undefined }
}
function write(key: string, open: boolean) {
  try { localStorage.setItem(key, open ? 'open' : 'closed') } catch { /* the layout still works unsaved */ }
}

/**
 * A page with one docked column on the right. Measured against the page's own width: when the middle
 * would be squeezed below `middleMin` the page is not docked at all (the caller shows tabs instead).
 * Open/closed is remembered per browser under `storageKey`; a person who never chose gets it open
 * when there is comfortable room. `requested` (the address names the column) opens it and keeps it open until
 * it is closed by hand.
 */
export function useSideColumn({ storageKey, middleMin, requested }: { storageKey: string; middleMin: number; requested: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [hostWidth, setHostWidth] = useState(0)
  const [choice, setChoice] = useState<boolean | undefined>(() => read(storageKey))
  const [dismissed, setDismissed] = useState(false)
  // Asked for by the address once: it stays open when the person then follows a link out of it.
  const [asked, setAsked] = useState(requested)
  if (requested && !asked) setAsked(true)
  // Until the width is known assume a wide page, so nothing flashes into tabs.
  const docked = sideFits(hostWidth || 2000, middleMin)
  const roomy = hostWidth >= SIDE_WIDTH + SIDE_GAP + middleMin + COMFORT

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setHostWidth(entries[0]?.contentRect.width ?? host.clientWidth))
    observer.observe(host)
    setHostWidth(host.clientWidth)
    return () => observer.disconnect()
  }, [])

  const open = docked && ((asked && !dismissed) || (choice ?? roomy))
  function toggle() {
    const next = !open
    setChoice(next)
    setDismissed(!next)
    write(storageKey, next)
  }
  return { hostRef, docked, open, toggle }
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Column widths of the three-column playback page: channels | playback | search. */
export const LEFT_WIDTH = 256
export const RIGHT_WIDTH = 320
export const MIDDLE_MIN = 400
export const COLUMN_GAP = 16
/** Below this the columns stack: the channel list, the player and the search panel one after another. */
export const STACK_BELOW = LEFT_WIDTH + MIDDLE_MIN + 2 * COLUMN_GAP

export type Focus = 'left' | 'right'

/** Which side columns are shown for a host width. A column that does not fit beside the player folds
 *  away instead of floating over it; when both are wanted and only one fits, the one asked for last stays. */
export function dockedLayout(hostWidth: number, wantLeft: boolean, wantRight: boolean, focus: Focus) {
  const stacked = hostWidth < STACK_BELOW
  let showLeft = wantLeft, showRight = wantRight
  // Stacked (a phone or a narrow window) the player comes first: only the column asked for last is open.
  if (stacked && showLeft && showRight) { if (focus === 'right') showLeft = false; else showRight = false }
  if (!stacked) {
    const room = hostWidth - 2 * COLUMN_GAP
    if (showLeft && showRight && room < LEFT_WIDTH + RIGHT_WIDTH + MIDDLE_MIN) {
      if (focus === 'right') showLeft = false
      else showRight = false
    }
    if (showRight && room < RIGHT_WIDTH + MIDDLE_MIN) showRight = false
  }
  return { stacked, showLeft, showRight, fitsBoth: hostWidth - 2 * COLUMN_GAP >= LEFT_WIDTH + RIGHT_WIDTH + MIDDLE_MIN }
}

const KEY = 'playback.columns'
function readSaved(): { left?: boolean; right?: boolean } {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {} } catch { return {} }
}
function save(patch: { left?: boolean; right?: boolean }) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...readSaved(), ...patch })) } catch { /* the layout still works unsaved */ }
}

/** Open/closed state of the side columns, measured against the page's own width, remembered per browser.
 *  A toggle acts on what is visible: asking for a column that was folded away shows it. */
export function useDockedColumns({ searchRequested }: { searchRequested: boolean }) {
  const hostRef = useRef<HTMLElement>(null)
  const [hostWidth, setHostWidth] = useState(0)
  const saved = useRef(readSaved())
  const [wantLeft, setWantLeft] = useState(saved.current.left ?? true)
  const [wantRight, setWantRight] = useState(searchRequested || (saved.current.right ?? false))
  const [focus, setFocus] = useState<Focus>(searchRequested ? 'right' : 'left')
  // Until the width is known assume a wide page, so nothing flashes folded.
  const layout = dockedLayout(hostWidth || 2000, wantLeft, wantRight, focus)
  const chosen = useRef(searchRequested || saved.current.right !== undefined)

  // Measured before the first paint, so a remembered open column never flashes squeezed on a narrow page.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => setHostWidth(entries[0]?.contentRect.width ?? host.clientWidth))
    observer.observe(host)
    setHostWidth(host.clientWidth)
    return () => observer.disconnect()
  }, [])
  // A wide enough page shows the search column from the start, unless the person already chose.
  useEffect(() => {
    if (chosen.current || !hostWidth || !layout.fitsBoth) return
    chosen.current = true
    setWantRight(true)
  }, [hostWidth, layout.fitsBoth])

  function toggleLeft() {
    if (layout.showLeft) { setWantLeft(false); save({ left: false }) } else { setWantLeft(true); setFocus('left'); save({ left: true }) }
  }
  function openRight() { chosen.current = true; setWantRight(true); setFocus('right'); save({ right: true }) }
  function closeRight() { chosen.current = true; setWantRight(false); save({ right: false }) }
  function toggleRight() { if (layout.showRight) closeRight(); else openRight() }
  return { hostRef, stacked: layout.stacked, showLeft: layout.showLeft, showRight: layout.showRight, fitsBoth: layout.fitsBoth, toggleLeft, toggleRight, closeRight }
}

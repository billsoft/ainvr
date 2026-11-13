import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDiscardConfirmation } from '@/components/modals/useDiscardConfirmation'
import { isWholePicture, minCropFraction, normalizeCrop, type ReferenceCrop, type SearchReference } from '@/features/searchReference'

type Drag = { mode: 'new' | 'move' | 'nw' | 'ne' | 'sw' | 'se'; startX: number; startY: number; base: ReferenceCrop }
const corners = ['nw', 'ne', 'sw', 'se'] as const
const button = 'inline-flex min-h-11 items-center justify-center rounded-base border border-line bg-surface px-4 text-sm text-ink-subtle hover:border-primary hover:text-primary'

/** Optional selection of the part to search for. The selection is kept as fractions of the picture,
 * so zoom, rotation and window size never move it. Close, cancel and Escape share
 * the same draft-discard confirmation and keep the last confirmed selection. */
export function ReferenceCropDialog({ reference, onClose, onConfirm }: {
  reference: SearchReference
  onClose: () => void
  onConfirm: (crop: ReferenceCrop | null) => void
}) {
  const [crop, setCrop] = useState<ReferenceCrop>(reference.crop ?? { x: 0.2, y: 0.2, w: 0.6, h: 0.6 })
  const initialCrop = useRef(crop)
  const { requestDiscard, dialog: discardDialog } = useDiscardConfirmation()
  const dirty = (Object.keys(crop) as (keyof ReferenceCrop)[]).some(key => Math.abs(crop[key] - initialCrop.current[key]) > 1e-6)
  const close = () => requestDiscard(dirty, '新的框选范围尚未应用，放弃后保留上次确认的选区。', onClose)
  const closeCurrent = useRef(close)
  closeCurrent.current = close
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  const area = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  // Fit the whole picture, centred and at its own aspect ratio.
  useLayoutEffect(() => {
    const element = area.current
    if (!element) return
    const fit = () => {
      const bounds = element.getBoundingClientRect()
      const scale = Math.min(bounds.width / reference.width, bounds.height / reference.height)
      if (scale > 0 && Number.isFinite(scale)) setFrame({ width: reference.width * scale, height: reference.height * scale })
      else setFrame({ width: bounds.width || 320, height: (bounds.width || 320) * reference.height / reference.width })
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [reference.width, reference.height])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ;(surface.current ?? dialog.current?.querySelector<HTMLButtonElement>('button'))?.focus()
    const keyboard = (event: KeyboardEvent) => {
      const stack = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (stack[stack.length - 1] !== dialog.current) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); closeCurrent.current()
      } else if (event.key === 'Tab' && dialog.current) {
        const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex="0"]'))
        const first = controls[0], last = controls[controls.length - 1]
        if (!first) return
        if (!dialog.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => { document.removeEventListener('keydown', keyboard, true); document.body.style.overflow = savedOverflow; previous?.focus?.() }
  }, [])
  const point = (event: React.PointerEvent) => {
    const bounds = surface.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)), y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)) }
  }
  function begin(event: React.PointerEvent, mode: Drag['mode']) {
    event.preventDefault(); event.stopPropagation()
    const p = point(event)
    drag.current = { mode, startX: p.x, startY: p.y, base: crop }
    surface.current?.setPointerCapture?.(event.pointerId)
    if (mode === 'new') setCrop(normalizeCrop({ x: p.x, y: p.y, w: minCropFraction, h: minCropFraction }))
  }
  function moveTo(event: React.PointerEvent) {
    const current = drag.current
    if (!current) return
    const p = point(event), dx = p.x - current.startX, dy = p.y - current.startY, b = current.base
    if (current.mode === 'new') {
      setCrop(normalizeCrop({ x: Math.min(current.startX, p.x), y: Math.min(current.startY, p.y), w: Math.abs(dx), h: Math.abs(dy) }))
    } else if (current.mode === 'move') {
      setCrop(normalizeCrop({ ...b, x: b.x + dx, y: b.y + dy }))
    } else {
      // The opposite corner stays where it is.
      const left = current.mode.endsWith('w') ? Math.min(b.x + dx, b.x + b.w - minCropFraction) : b.x
      const right = current.mode.endsWith('e') ? Math.max(b.x + b.w + dx, b.x + minCropFraction) : b.x + b.w
      const top = current.mode.startsWith('n') ? Math.min(b.y + dy, b.y + b.h - minCropFraction) : b.y
      const bottom = current.mode.startsWith('s') ? Math.max(b.y + b.h + dy, b.y + minCropFraction) : b.y + b.h
      const x = Math.max(0, left), y = Math.max(0, top)
      setCrop(normalizeCrop({ x, y, w: Math.min(1, right) - x, h: Math.min(1, bottom) - y }))
    }
  }
  function end(event: React.PointerEvent) {
    if (!drag.current) return
    drag.current = null
    try { surface.current?.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
  }
  function keys(event: React.KeyboardEvent) {
    const step = 0.02
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    // Shift resizes from the bottom-right corner; plain arrows move the selection.
    setCrop(c => normalizeCrop(event.shiftKey ? { ...c, w: c.w + move[0], h: c.h + move[1] } : { ...c, x: c.x + move[0], y: c.y + move[1] }))
  }
  const percent = (value: number) => `${value * 100}%`
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="reference-crop-title" className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col gap-3 rounded-panel bg-surface p-4 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 id="reference-crop-title" className="text-base font-semibold text-ink">框选要找的目标</h2>
          <p className="mt-1 text-xs text-ink-subtle">拖动画出选区，拖动选区内部移动，拖动四角调整大小；只按选区内容查找。不框选则使用整张图片。</p></div>
        <button type="button" aria-label="关闭" className={`${button} shrink-0 px-3`} onClick={close}><X size={18} /></button>
      </div>
      <div ref={area} className="flex min-h-[200px] shrink items-center justify-center overflow-hidden rounded-lg bg-slate-950" style={{ height: 'min(60dvh, 560px)' }}>
        {frame && <div ref={surface} tabIndex={0} role="group" aria-label="选区，方向键移动，Shift 加方向键调整大小"
          aria-description={`选区位于左 ${Math.round(crop.x * 100)}%、上 ${Math.round(crop.y * 100)}%，宽 ${Math.round(crop.w * 100)}%、高 ${Math.round(crop.h * 100)}%`}
          className="relative cursor-crosshair touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={e => begin(e, 'new')} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end} onKeyDown={keys}>
          <img src={reference.url} alt="参考图片" draggable={false} className="pointer-events-none h-full w-full" />
          {/* Light dimming outside only: the colours inside the selection stay exactly as photographed. */}
          <div aria-hidden="true" className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.38)]"
            style={{ left: percent(crop.x), top: percent(crop.y), width: percent(crop.w), height: percent(crop.h) }}>
            <div className="pointer-events-auto absolute inset-0 cursor-move" onPointerDown={e => begin(e, 'move')} />
            {corners.map(corner => <span key={corner} onPointerDown={e => begin(e, corner)}
              className={`pointer-events-auto absolute flex h-11 w-11 items-center justify-center ${corner.startsWith('n') ? '-top-[22px]' : '-bottom-[22px]'} ${corner.endsWith('w') ? '-left-[22px]' : '-right-[22px]'} ${corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}>
              <span className="h-4 w-4 rounded-full border-2 border-primary bg-white shadow" />
            </span>)}
          </div>
        </div>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className={`${button} mr-auto`} onClick={() => onConfirm(null)}>使用整图</button>
        <button type="button" className={button} onClick={close}>取消</button>
        <button type="button" className="inline-flex min-h-11 items-center rounded-base bg-primary px-4 text-sm text-white hover:bg-primary/90" onClick={() => onConfirm(isWholePicture(crop) ? null : normalizeCrop(crop))}>使用选区</button>
      </div>
    </div>
    {discardDialog}
  </div>, document.body)
}

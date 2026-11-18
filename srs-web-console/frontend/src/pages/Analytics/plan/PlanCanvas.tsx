import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KImage, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva'
import { useElementSize } from '../TrendChart'
import { PLAN_H, PLAN_W, planViewport, type NewShape, type Placement, type Plan, type PlanShape, type ZoneInfo } from './planModel'
import { layoutMapLabels, type MapAnnotation } from './mapLabels'
import type { HeatVariant } from '../RegionHeatPanel'

export type PlanTool = 'select' | 'pan' | 'room' | 'line' | 'label'
/** Editor camera: zoom 1 fits the whole board; x/y shift it on screen in pixels. */
export interface PlanView { zoom: number; x: number; y: number }
export interface PlanCanvasProps {
  plan: Plan | null
  zones: ZoneInfo[]
  /** Count-derived display field, independent of the editable placement outlines. */
  heat?: number[][]
  annotations?: Record<string, MapAnnotation>
  heatMin?: number
  heatPalette?: 'flow' | 'alarm'
  /** Source-coordinate inset in a planned display box, never a ground projection. */
  sourceHeat?: {zoneKey:string;variant:HeatVariant}|null
  selectedKey: string | null
  selectedShapeId?: string | null
  tool?: PlanTool
  readOnly?: boolean
  onSelectZone: (key: string | null) => void
  onSelectShape?: (id: string | null) => void
  onChangeZone?: (key: string, placement: Placement) => void
  onChangeShape?: (id: string, patch: Partial<NewShape>) => void
  onCreateShape?: (shape: NewShape) => void
  /** Editing only: the camera (zoom/pan), the dotted grid, snapping step (0 off) and base image opacity. */
  view?: PlanView
  onViewChange?: (view: PlanView) => void
  grid?: boolean
  snap?: number
  imageOpacity?: number
}
const ZOOM_MIN = 0.25, ZOOM_MAX = 8

function useImage(src: string | undefined) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!src) { setImage(null); return }
    setImage(null)
    const img = new window.Image(); let alive = true
    img.onload = () => { if (alive) setImage(img) }
    img.onerror = () => { if (alive) setImage(null) }
    img.src = src
    return () => { alive = false }
  }, [src])
  return image
}

/** 平面图画布：用成熟的绘图库（Konva）处理拖动、缩放和触屏手势，这里只负责把模型画出来、把改动交回去。 */
export function PlanCanvas(props: PlanCanvasProps) {
  const { plan, zones, selectedKey, selectedShapeId = null, tool = 'select', readOnly = false } = props
  const [box, { w, h }] = useElementSize<HTMLDivElement>({ w: 800, h: 450 })
  const viewport = useMemo(() => planViewport(plan, readOnly), [plan, readOnly])
  // The display page fits the planned content; the editor shows the whole board inside a movable, zoomable camera.
  const camera = !readOnly ? props.view : undefined
  const fitBoard = Math.max(0.005, Math.min(w / PLAN_W, h / PLAN_H) * 0.92)
  const scale = camera ? fitBoard * camera.zoom : Math.max(0.005, Math.min(w / viewport.w, h / viewport.h))
  const originX = camera ? (w - PLAN_W * scale) / 2 + camera.x : 0, originY = camera ? (h - PLAN_H * scale) / 2 + camera.y : 0
  const stage = useRef<Konva.Stage>(null), transformer = useRef<Konva.Transformer>(null)
  const step = !readOnly ? props.snap ?? 0 : 0
  const sn = (v: number) => step ? Math.round(v / step) * step : Math.round(v)
  // Walls join: a point near an existing wall end lands exactly on it.
  const join = (p: { x: number; y: number }) => {
    let best: { x: number; y: number } | null = null, dist = 14 / scale
    for (const s of plan?.shapes ?? []) if (s.kind === 'line') for (const [x, y] of [[s.points[0], s.points[1]], [s.points[2], s.points[3]]] as const) {
      const d = Math.hypot(x - p.x, y - p.y); if (d < dist) { dist = d; best = { x, y } }
    }
    return best ?? { x: sn(p.x), y: sn(p.y) }
  }
  const pinch = useRef<{ d: number; cx: number; cy: number } | null>(null)
  const zoomAt = (px: number, py: number, factor: number, dx = 0, dy = 0) => {
    if (!camera) return
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.zoom * factor)), next = fitBoard * zoom
    const wx = (px - originX) / scale, wy = (py - originY) / scale
    props.onViewChange?.({ zoom, x: px + dx - wx * next - (w - PLAN_W * next) / 2, y: py + dy - wy * next - (h - PLAN_H * next) / 2 })
  }
  const wheel = (e: KonvaEventObject<WheelEvent>) => {
    if (!camera) return
    e.evt.preventDefault()
    const p = stage.current?.getPointerPosition(); if (!p) return
    zoomAt(p.x, p.y, Math.exp(-e.evt.deltaY * 0.0015))
  }
  const image = useImage(plan?.image?.data)
  const [drag, setDrag] = useState<{ kind: 'room' | 'line'; x0: number; y0: number; x1: number; y1: number } | null>(null)
  const byKey = useMemo(() => new Map(zones.map(z => [z.key, z])), [zones])
  const fit = plan?.image ? Math.min(PLAN_W / plan.image.w, PLAN_H / plan.image.h) : 1
  const nameSize = readOnly ? Math.max(22, 10 / scale) : 22
  const labels = useMemo(() => readOnly && props.annotations ? layoutMapLabels(plan?.placements ?? {}, Object.keys(props.annotations), viewport, w, h, selectedKey) : [], [readOnly, props.annotations, plan, viewport, w, h, selectedKey])
  const valueSize = readOnly ? Math.max(20, 10 / scale) : 20

  // 选中的热区或房间显示缩放手柄。
  useEffect(() => {
    const tr = transformer.current, s = stage.current
    if (!tr || !s) return
    const id = readOnly || (selectedKey && !byKey.has(selectedKey)) ? null : selectedKey ? `zone-${selectedKey}` : selectedShapeId ? `shape-${selectedShapeId}` : null
    const node = id ? s.findOne(`#${id}`) : null
    const resizable = node && (id!.startsWith('zone-') || plan?.shapes.find(x => `shape-${x.id}` === id)?.kind === 'room')
    tr.nodes(resizable ? [node!] : []); tr.getLayer()?.batchDraw()
  }, [selectedKey, selectedShapeId, plan, readOnly, byKey])

  const point = () => stage.current?.getRelativePointerPosition() ?? { x: 0, y: 0 }
  const down = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    if (readOnly || tool === 'pan') return
    if ('touches' in e.evt && e.evt.touches.length > 1) { setDrag(null); return }
    if (tool === 'select') { if (e.target === e.target.getStage() || e.target.name() === 'plan-bg') { props.onSelectZone(null); props.onSelectShape?.(null) } return }
    const raw = point(), p = tool === 'line' ? join(raw) : { x: sn(raw.x), y: sn(raw.y) }
    if (tool === 'label') { props.onCreateShape?.({ kind: 'label', x: p.x, y: p.y, text: '标签' }); return }
    setDrag({ kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const move = (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const touches = 'touches' in e.evt ? e.evt.touches : null
    if (camera && touches && touches.length === 2) {
      // Two fingers: pinch to zoom and move to pan, around the fingers' midpoint.
      e.evt.preventDefault()
      const rect = stage.current?.container().getBoundingClientRect(), a = touches[0]!, b = touches[1]!
      if (!rect) return
      const cx = (a.clientX + b.clientX) / 2 - rect.left, cy = (a.clientY + b.clientY) / 2 - rect.top, d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (pinch.current) zoomAt(pinch.current.cx, pinch.current.cy, d / Math.max(1, pinch.current.d), cx - pinch.current.cx, cy - pinch.current.cy)
      pinch.current = { d, cx, cy }; return
    }
    if (drag) { const raw = point(), p = drag.kind === 'line' ? join(raw) : { x: sn(raw.x), y: sn(raw.y) }; setDrag({ ...drag, x1: p.x, y1: p.y }) }
  }
  const up = () => {
    pinch.current = null
    if (!drag) return
    const dx = drag.x1 - drag.x0, dy = drag.y1 - drag.y0
    if (drag.kind === 'room' && Math.abs(dx) > 30 && Math.abs(dy) > 30) props.onCreateShape?.({ kind: 'room', x: Math.round(Math.min(drag.x0, drag.x1)), y: Math.round(Math.min(drag.y0, drag.y1)), w: Math.round(Math.abs(dx)), h: Math.round(Math.abs(dy)), name: '房间' })
    if (drag.kind === 'line' && Math.hypot(dx, dy) > 30) props.onCreateShape?.({ kind: 'line', points: [Math.round(drag.x0), Math.round(drag.y0), Math.round(drag.x1), Math.round(drag.y1)] })
    setDrag(null)
  }
  // 缩放结束后把缩放系数折算成宽高并复位，模型里只保存真实尺寸。
  const resized = (node: Konva.Node, base: { x: number; y: number; w: number; h: number }) => {
    const next = { x: sn(node.x()), y: sn(node.y()), w: Math.max(40, sn(base.w * node.scaleX())), h: Math.max(30, sn(base.h * node.scaleY())) }
    node.scale({ x: 1, y: 1 }); return next
  }
  const shape = (s: PlanShape) => {
    const selected = selectedShapeId === s.id, pick = (e: KonvaEventObject<Event>) => { e.cancelBubble = true; if (!readOnly) { props.onSelectShape?.(s.id); props.onSelectZone(null) } }
    const stroke = selected ? '#1677ff' : '#64748b'
    if (s.kind === 'room') return <Group key={s.id} id={`shape-${s.id}`} x={s.x} y={s.y} draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => props.onChangeShape?.(s.id, { x: sn(e.target.x()), y: sn(e.target.y()) })}
      onTransformEnd={e => props.onChangeShape?.(s.id, resized(e.target, s))}>
      <Rect width={s.w} height={s.h} stroke={stroke} strokeWidth={3} fill="transparent" />
      <Text text={s.name} x={10} y={8} fontSize={20} fill="#475569" listening={false} />
    </Group>
    if (s.kind === 'line') return <Line key={s.id} id={`shape-${s.id}`} points={s.points} stroke={stroke} strokeWidth={6} hitStrokeWidth={24} lineCap="round" draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => { const n = e.target, dx = sn(n.x()), dy = sn(n.y()); n.position({ x: 0, y: 0 }); props.onChangeShape?.(s.id, { points: [s.points[0] + dx, s.points[1] + dy, s.points[2] + dx, s.points[3] + dy].map(Math.round) as [number, number, number, number] }) }} />
    return <Text key={s.id} id={`shape-${s.id}`} text={s.text} x={s.x} y={s.y} fontSize={26} fill={selected ? '#1677ff' : '#334155'} draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => props.onChangeShape?.(s.id, { x: sn(e.target.x()), y: sn(e.target.y()) })} />
  }

  const cursor = !camera ? undefined : tool === 'pan' ? 'grab' : tool === 'select' ? undefined : 'crosshair'
  const gap = 40
  return <div ref={box} style={{ cursor, touchAction: camera ? 'none' : undefined }} className={`relative flex min-h-[14rem] flex-1 items-center justify-center [@container(min-width:44rem)]:min-h-0 overflow-hidden ${camera ? 'bg-slate-100' : 'rounded-base border border-line bg-white'}`}>
    <Stage ref={stage} width={camera ? w : viewport.w * scale} height={camera ? h : viewport.h * scale} scaleX={scale} scaleY={scale} x={originX} y={originY} offsetX={camera ? 0 : viewport.x} offsetY={camera ? 0 : viewport.y}
      draggable={!!camera && tool === 'pan'} onDragMove={e => { if (camera && e.target === e.target.getStage()) props.onViewChange?.({ ...camera, x: e.target.x() - (w - PLAN_W * scale) / 2, y: e.target.y() - (h - PLAN_H * scale) / 2 }) }}
      onWheel={wheel} onMouseDown={down} onTouchStart={down} onMouseMove={move} onTouchMove={move} onMouseUp={up} onTouchEnd={up}>
      <Layer>
        <Rect name="plan-bg" width={PLAN_W} height={PLAN_H} fill="#ffffff" {...(camera ? { shadowColor: '#0f172a', shadowBlur: 18 / scale, shadowOpacity: 0.12, shadowOffsetY: 2 / scale } : {})} />
        {image && plan?.image && <KImage image={image} x={(PLAN_W - plan.image.w * fit) / 2} y={(PLAN_H - plan.image.h * fit) / 2} width={plan.image.w * fit} height={plan.image.h * fit} opacity={readOnly ? 0.9 : props.imageOpacity ?? 0.9} listening={false} />}
        {camera && props.grid && gap * scale >= 6 && <Shape name="plan-grid" listening={false} sceneFunc={context => {
          context.fillStyle = '#94a3b8'
          const r = 1.2 / scale
          for (let x = gap; x < PLAN_W; x += gap) for (let y = gap; y < PLAN_H; y += gap) context.fillRect(x - r, y - r, r * 2, r * 2)
        }} />}
        {plan?.shapes.map(shape)}
      </Layer>
      {readOnly && props.heat && <Layer name="count-heat-overlay" listening={false}>
        <Shape name="count-heat-field" sceneFunc={context => {
          const heat = props.heat!, rows = heat.length, cols = heat[0]?.length ?? 0
          if (!rows || !cols) return
          const cw = PLAN_W / cols, ch = PLAN_H / rows
          for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            const value = heat[y]![x] ?? 0
            if (!Number.isFinite(value) || value <= .06 || value < (props.heatMin ?? 0)) continue
            const t = Math.min(1, value)
            const hue=props.heatPalette==='alarm'?45*(1-t):220*(1-t)
            context.fillStyle = `hsla(${Math.round(hue)},90%,50%,${(.12 + .58 * t).toFixed(3)})`
            context.fillRect(x * cw, y * ch, cw + .5, ch + .5)
          }
        }} />
      </Layer>}
      {readOnly && props.sourceHeat && plan?.placements[props.sourceHeat.zoneKey] && <Layer name="source-heat-inset" listening={false}>
        <Shape sceneFunc={context=>{
          const {zoneKey,variant:v}=props.sourceHeat!,pl=plan!.placements[zoneKey]!
          const fit=Math.min(pl.w/v.source_width,pl.h/v.source_height),iw=v.source_width*fit,ih=v.source_height*fit
          const x=pl.x+(pl.w-iw)/2,y=pl.y+(pl.h-ih)/2,max=Math.max(1,...v.values_ms)
          v.values_ms.forEach((n,i)=>{if(n<=0||n/max<(props.heatMin??0))return
            context.fillStyle=`hsla(${Math.round(220*(1-n/max))},90%,50%,.7)`
            context.fillRect(x+(i%v.columns)*iw/v.columns,y+Math.floor(i/v.columns)*ih/v.rows,iw/v.columns,ih/v.rows)
          })
        }}/>
      </Layer>}
      <Layer>
        {plan && Object.entries(plan.placements).map(([key, pl]) => {
          const z = byKey.get(key), missing = !z
          const on = selectedKey === key
          return <Group key={key} id={`zone-${key}`} x={pl.x} y={pl.y} draggable={!readOnly && !missing && tool === 'select'}
            onClick={e => { e.cancelBubble = true; props.onSelectZone(key); props.onSelectShape?.(null) }} onTap={e => { e.cancelBubble = true; props.onSelectZone(key); props.onSelectShape?.(null) }}
            onDragEnd={e => props.onChangeZone?.(key, { ...pl, x: sn(e.target.x()), y: sn(e.target.y()) })}
            onTransformEnd={e => props.onChangeZone?.(key, resized(e.target, pl))}>
            <Rect name="placement-outline" width={pl.w} height={pl.h} cornerRadius={8} fill="transparent" stroke={on ? '#1677ff' : missing ? '#b45309' : '#64748b'} strokeWidth={readOnly ? on ? 1.5 : 1 : on ? 5 : 2.5} strokeScaleEnabled={!readOnly} dash={on && !missing ? undefined : [10, 7]} />
            {!(readOnly && props.annotations?.[key]) && <Text text={z?.name ?? '失效/未读取引用'} x={10} y={8} width={Math.max(10, pl.w - 20)} fontSize={nameSize} fill="#0f172a" ellipsis wrap="none" listening={false} />}
            {missing && <Text text={key} x={10} y={Math.max(36, 8 + nameSize + 3 / scale)} fontSize={valueSize} fill="#0f172a" listening={false} />}
          </Group>
        })}
        {drag && (drag.kind === 'room'
          ? <Rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} stroke="#1677ff" dash={[8, 6]} strokeWidth={3} listening={false} />
          : <Line points={[drag.x0, drag.y0, drag.x1, drag.y1]} stroke="#1677ff" strokeWidth={5} dash={[8, 6]} listening={false} />)}
        {drag?.kind === 'line' && <Text x={(drag.x0 + drag.x1) / 2} y={(drag.y0 + drag.y1) / 2 - 26 / scale} text={String(Math.round(Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0)))} fontSize={13 / scale} fill="#1677ff" listening={false} />}
        {!readOnly && <Transformer ref={transformer} rotateEnabled={false} keepRatio={false} flipEnabled={false} anchorSize={14} borderStroke="#1677ff" anchorStroke="#1677ff"
          boundBoxFunc={(oldBox, next) => next.width < 40 * scale || next.height < 30 * scale ? oldBox : next} />}
      </Layer>
    </Stage>
    {labels.length > 0 && <div className="pointer-events-none absolute inset-0" aria-label="热区数据标签">
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">{labels.map(l=><line key={l.key} x1={l.anchorX} y1={l.anchorY} x2={l.x+l.w/2} y2={l.y+l.h/2} stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 3" />)}</svg>
      {labels.map(l => <button key={l.key} type="button" aria-pressed={selectedKey===l.key} aria-label={`${byKey.get(l.key)?.name ?? l.key}：${props.annotations![l.key]!.detail}`} title={props.annotations![l.key]!.detail}
        className={`pointer-events-auto absolute overflow-hidden border bg-white/95 text-left shadow-sm backdrop-blur-sm transition-colors hover:border-primary focus-visible:outline-primary ${selectedKey===l.key?'border-primary ring-1 ring-primary':'border-slate-200'} ${l.compact?'rounded-full text-center text-[10px]':'rounded-lg px-2.5 py-1.5'}`}
        style={{left:l.x,top:l.y,width:l.w,height:l.h}} onClick={()=>props.onSelectZone(selectedKey===l.key?null:l.key)}>
        {l.compact?l.ordinal:<><span className="block truncate text-xs font-medium text-ink">{byKey.get(l.key)?.name ?? l.key}</span><span className="block truncate text-[11px] tabular-nums text-ink-subtle">{props.annotations![l.key]!.summary}</span></>}
      </button>)}
    </div>}
  </div>
}

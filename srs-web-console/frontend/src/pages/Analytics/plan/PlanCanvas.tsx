import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Group, Image as KImage, Layer, Line, Rect, Shape, Stage, Text, Transformer } from 'react-konva'
import { useElementSize } from '../TrendChart'
import { PLAN_H, PLAN_W, planViewport, type NewShape, type Placement, type Plan, type PlanShape, type ZoneInfo } from './planModel'
import type { HeatVariant } from '../RegionHeatPanel'

export type PlanTool = 'select' | 'room' | 'line' | 'label'
export interface PlanCanvasProps {
  plan: Plan | null
  zones: ZoneInfo[]
  /** Values from one explicitly chosen counter and direction; absent means unknown. */
  /** Count-derived display field, independent of the editable placement outlines. */
  heat?: number[][]
  heatMin?: number
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
}

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
  const scale = Math.max(0.005, Math.min(w / viewport.w, h / viewport.h))
  const stage = useRef<Konva.Stage>(null), transformer = useRef<Konva.Transformer>(null)
  const image = useImage(plan?.image?.data)
  const [drag, setDrag] = useState<{ kind: 'room' | 'line'; x0: number; y0: number; x1: number; y1: number } | null>(null)
  const byKey = useMemo(() => new Map(zones.map(z => [z.key, z])), [zones])
  const fit = plan?.image ? Math.min(PLAN_W / plan.image.w, PLAN_H / plan.image.h) : 1
  const nameSize = readOnly ? Math.max(22, 10 / scale) : 22
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
    if (readOnly) return
    if (tool === 'select') { if (e.target === e.target.getStage() || e.target.name() === 'plan-bg') { props.onSelectZone(null); props.onSelectShape?.(null) } return }
    const p = point()
    if (tool === 'label') { props.onCreateShape?.({ kind: 'label', x: Math.round(p.x), y: Math.round(p.y), text: '标签' }); return }
    setDrag({ kind: tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const move = () => { if (drag) { const p = point(); setDrag({ ...drag, x1: p.x, y1: p.y }) } }
  const up = () => {
    if (!drag) return
    const dx = drag.x1 - drag.x0, dy = drag.y1 - drag.y0
    if (drag.kind === 'room' && Math.abs(dx) > 30 && Math.abs(dy) > 30) props.onCreateShape?.({ kind: 'room', x: Math.round(Math.min(drag.x0, drag.x1)), y: Math.round(Math.min(drag.y0, drag.y1)), w: Math.round(Math.abs(dx)), h: Math.round(Math.abs(dy)), name: '房间' })
    if (drag.kind === 'line' && Math.hypot(dx, dy) > 30) props.onCreateShape?.({ kind: 'line', points: [Math.round(drag.x0), Math.round(drag.y0), Math.round(drag.x1), Math.round(drag.y1)] })
    setDrag(null)
  }
  // 缩放结束后把缩放系数折算成宽高并复位，模型里只保存真实尺寸。
  const resized = (node: Konva.Node, base: { x: number; y: number; w: number; h: number }) => {
    const next = { x: Math.round(node.x()), y: Math.round(node.y()), w: Math.round(Math.max(40, base.w * node.scaleX())), h: Math.round(Math.max(30, base.h * node.scaleY())) }
    node.scale({ x: 1, y: 1 }); return next
  }
  const shape = (s: PlanShape) => {
    const selected = selectedShapeId === s.id, pick = (e: KonvaEventObject<Event>) => { e.cancelBubble = true; if (!readOnly) { props.onSelectShape?.(s.id); props.onSelectZone(null) } }
    const stroke = selected ? '#1677ff' : '#64748b'
    if (s.kind === 'room') return <Group key={s.id} id={`shape-${s.id}`} x={s.x} y={s.y} draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => props.onChangeShape?.(s.id, { x: Math.round(e.target.x()), y: Math.round(e.target.y()) })}
      onTransformEnd={e => props.onChangeShape?.(s.id, resized(e.target, s))}>
      <Rect width={s.w} height={s.h} stroke={stroke} strokeWidth={3} fill="transparent" />
      <Text text={s.name} x={10} y={8} fontSize={20} fill="#475569" listening={false} />
    </Group>
    if (s.kind === 'line') return <Line key={s.id} id={`shape-${s.id}`} points={s.points} stroke={stroke} strokeWidth={6} hitStrokeWidth={24} lineCap="round" draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => { const n = e.target, dx = n.x(), dy = n.y(); n.position({ x: 0, y: 0 }); props.onChangeShape?.(s.id, { points: [s.points[0] + dx, s.points[1] + dy, s.points[2] + dx, s.points[3] + dy].map(Math.round) as [number, number, number, number] }) }} />
    return <Text key={s.id} id={`shape-${s.id}`} text={s.text} x={s.x} y={s.y} fontSize={26} fill={selected ? '#1677ff' : '#334155'} draggable={!readOnly && tool === 'select'} onClick={pick} onTap={pick}
      onDragEnd={e => props.onChangeShape?.(s.id, { x: Math.round(e.target.x()), y: Math.round(e.target.y()) })} />
  }

  return <div ref={box} className="relative flex min-h-[14rem] flex-1 items-center justify-center lg:min-h-0 overflow-hidden rounded-base border border-line bg-white">
    <Stage ref={stage} width={viewport.w * scale} height={viewport.h * scale} scaleX={scale} scaleY={scale} offsetX={viewport.x} offsetY={viewport.y} onMouseDown={down} onTouchStart={down} onMouseMove={move} onTouchMove={move} onMouseUp={up} onTouchEnd={up}>
      <Layer>
        <Rect name="plan-bg" width={PLAN_W} height={PLAN_H} fill="#ffffff" />
        {image && plan?.image && <KImage image={image} x={(PLAN_W - plan.image.w * fit) / 2} y={(PLAN_H - plan.image.h * fit) / 2} width={plan.image.w * fit} height={plan.image.h * fit} opacity={0.9} listening={false} />}
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
            context.fillStyle = `hsla(${Math.round(220 * (1 - t))},90%,50%,${(.12 + .58 * t).toFixed(3)})`
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
            onDragEnd={e => props.onChangeZone?.(key, { ...pl, x: Math.round(e.target.x()), y: Math.round(e.target.y()) })}
            onTransformEnd={e => props.onChangeZone?.(key, resized(e.target, pl))}>
            <Rect name="placement-outline" width={pl.w} height={pl.h} cornerRadius={8} fill="transparent" stroke={on ? '#1677ff' : missing ? '#b45309' : '#64748b'} strokeWidth={readOnly ? on ? 1.5 : 1 : on ? 5 : 2.5} strokeScaleEnabled={!readOnly} dash={on && !missing ? undefined : [10, 7]} />
            <Text text={z?.name ?? '失效/未读取引用'} x={10} y={8} width={Math.max(10, pl.w - 20)} fontSize={nameSize} fill="#0f172a" ellipsis wrap="none" listening={false} />
            {missing && <Text text={key} x={10} y={Math.max(36, 8 + nameSize + 3 / scale)} fontSize={valueSize} fill="#0f172a" listening={false} />}
          </Group>
        })}
        {drag && (drag.kind === 'room'
          ? <Rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} stroke="#1677ff" dash={[8, 6]} strokeWidth={3} listening={false} />
          : <Line points={[drag.x0, drag.y0, drag.x1, drag.y1]} stroke="#1677ff" strokeWidth={5} dash={[8, 6]} listening={false} />)}
        {!readOnly && <Transformer ref={transformer} rotateEnabled={false} keepRatio={false} flipEnabled={false} anchorSize={14} borderStroke="#1677ff" anchorStroke="#1677ff"
          boundBoxFunc={(oldBox, next) => next.width < 40 * scale || next.height < 30 * scale ? oldBox : next} />}
      </Layer>
    </Stage>
  </div>
}

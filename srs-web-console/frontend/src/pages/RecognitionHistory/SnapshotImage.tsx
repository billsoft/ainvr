import { useId, useState } from 'react'
import { AuthImage } from '@/components/common/AuthImage'
import type { SnapshotItem } from '@/types/snapshot'
import { snapshotPointPosition } from '@/utils/snapshotPoint'

interface Props {
  channelId: string
  item: SnapshotItem
  className?: string
  objectFit?: 'cover' | 'contain'
  variant?: 'processed' | 'original'
}

/** Points show on their context image;legacy object crops keep their original view. */
export function SnapshotImage({ channelId, item, className, objectFit = 'cover', variant = 'processed' }: Props) {
  const [loadedKey, setLoadedKey] = useState('')
  const clipId = useId().replaceAll(':', '_')
  const key = `${item.image_id}:${variant}`
  const position = snapshotPointPosition(item)
  const width = item.image_width ?? 0, height = item.image_height ?? 0
  const validSize = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192
  const image = { channelId, imageId: item.image_id, alt: item.class_name, objectFit, variant }
  if (!position || !validSize) return <AuthImage {...image} className={className} />
  const x = position.x * width, y = position.y * height
  const radius = Math.max(4, Math.min(width, height) * .018)
  const rect = item.point!.context_image_rect ?? { x: 0, y: 0, w: 1, h: 1 }
  const left = rect.x * width, top = rect.y * height
  const right = (rect.x + rect.w) * width, bottom = (rect.y + rect.h) * height
  return (
    <div className={`relative ${className ?? ''}`}>
      <AuthImage key={key} {...image} className="h-full w-full" onImageLoaded={() => setLoadedKey(key)} />
      {loadedKey === key && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio={objectFit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'}
          role="img" aria-label={`定位点：${item.class_name}`} data-testid="snapshot-point-marker">
          <defs>
            <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
              <path d={`M ${left} ${top} H ${right} V ${bottom} H ${left} Z`} />
            </clipPath>
          </defs>
          <g fill="none" stroke="#22c55e" strokeWidth="2" clipPath={`url(#${clipId})`}>
            <circle cx={x} cy={y} r={radius} vectorEffect="non-scaling-stroke" />
            <path d={`M ${x - radius * 1.8} ${y} H ${x + radius * 1.8} M ${x} ${y - radius * 1.8} V ${y + radius * 1.8}`}
              vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { AuthImage } from '@/components/common/AuthImage'
import type { SearchBoundingBox } from '@/api/searchService'

/** The box belongs to this saved JPEG. Measure object-contain letterboxing,
 * rather than drawing raw-frame coordinates over a thumbnail container. */
export function SearchEvidenceImage({ path, alt, className, bbox }: { path: string; alt: string; className: string; bbox?: SearchBoundingBox }) {
  const root = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(0)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useEffect(() => {
    setBox(null)
    const parent = root.current, img = parent?.querySelector('img')
    if (!parent || !img || !bbox || !img.naturalWidth || !img.naturalHeight) return
    const measure = () => {
      const outer = parent.getBoundingClientRect(), bounds = img.getBoundingClientRect()
      const scale = Math.min(bounds.width / img.naturalWidth, bounds.height / img.naturalHeight)
      const width = img.naturalWidth * scale, height = img.naturalHeight * scale
      setBox({ left: bounds.left - outer.left + (bounds.width - width) / 2 + bbox[0] * width,
        top: bounds.top - outer.top + (bounds.height - height) / 2 + bbox[1] * height, width: bbox[2] * width, height: bbox[3] * height })
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(parent); observer.observe(img)
    return () => observer.disconnect()
  }, [path, bbox, loaded])
  return <div ref={root} className="relative min-w-0">
    <AuthImage path={path} alt={alt} className={className} objectFit="contain" onImageLoaded={() => setLoaded(n => n + 1)} />
    {box && <span aria-label="检测目标位置" className="pointer-events-none absolute border-2 border-emerald-400 shadow-[0_0_0_1px_#000]" style={box} />}
  </div>
}

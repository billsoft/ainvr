/** Reference image of a picture search. The browser crops and scales the picture into one small JPEG;
 * the selection never leaves this page as coordinates, only as the pixels the operator chose. */

/** Selection in image coordinates, each value a fraction of the full picture. */
export type ReferenceCrop = { x: number; y: number; w: number; h: number }
export interface SearchReference {
  /** Original picture as added (file, pasted image, or saved evidence). */
  blob: Blob
  url: string
  width: number
  height: number
  /** null = the whole picture. */
  crop: ReferenceCrop | null
  origin: 'upload' | 'result'
}

export const referenceAccept = 'image/jpeg,image/png'
export const referenceMaxFileBytes = 20 * 1024 * 1024
const maxDecodedPixels = 50_000_000
const minSide = 32
/** Larger than the model input (896 x 448); keeps the upload small. */
export const referenceMaxSide = 1024
export const referenceMaxJpegBytes = 480 * 1024
/** Smallest selection, as a fraction of each side, that still contains something to compare. */
export const minCropFraction = 0.04

export class ReferenceImageError extends Error {}

export function checkReferenceFile(file: Blob): void {
  if (!['image/jpeg', 'image/png'].includes(file.type)) throw new ReferenceImageError('请使用 JPEG 或 PNG 图片')
  if (file.size > referenceMaxFileBytes) throw new ReferenceImageError('图片超过 20MB，请换一张较小的图片')
  if (file.size === 0) throw new ReferenceImageError('图片内容为空，请换一张图片')
}

export function checkReferenceSize(width: number, height: number): void {
  if (width < minSide || height < minSide) throw new ReferenceImageError('图片太小，请换一张更清楚的图片')
  if (width * height > maxDecodedPixels) throw new ReferenceImageError('图片分辨率过大，请先缩小后再添加')
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Keep a selection inside the picture and at least the minimum size. */
export function normalizeCrop(crop: ReferenceCrop): ReferenceCrop {
  const w = clamp(crop.w, minCropFraction, 1), h = clamp(crop.h, minCropFraction, 1)
  return { x: clamp(crop.x, 0, 1 - w), y: clamp(crop.y, 0, 1 - h), w, h }
}

/** A selection that covers (almost) the whole picture is the whole picture. */
export function isWholePicture(crop: ReferenceCrop | null): boolean {
  return !crop || (crop.x <= 0.005 && crop.y <= 0.005 && crop.w >= 0.99 && crop.h >= 0.99)
}

/** Source pixels of the selection, then the even-sized output that fits the upload bound. */
export function referencePlan(width: number, height: number, crop: ReferenceCrop | null) {
  const c = crop ? normalizeCrop(crop) : { x: 0, y: 0, w: 1, h: 1 }
  const sx = Math.round(c.x * width), sy = Math.round(c.y * height)
  const sw = Math.max(1, Math.min(width - sx, Math.round(c.w * width)))
  const sh = Math.max(1, Math.min(height - sy, Math.round(c.h * height)))
  const scale = Math.min(1, referenceMaxSide / Math.max(sw, sh))
  // The hardware decoder needs even dimensions of at least 16 pixels.
  const even = (value: number) => Math.max(minSide, Math.floor(value / 2) * 2)
  return { sx, sy, sw, sh, width: even(sw * scale), height: even(sh * scale) }
}

/** Selection fraction to CSS background values that show only that part in a thumbnail. */
export function cropBackground(crop: ReferenceCrop | null) {
  const c = crop ? normalizeCrop(crop) : { x: 0, y: 0, w: 1, h: 1 }
  const pos = (start: number, size: number) => size >= 1 ? 0 : (start / (1 - size)) * 100
  return { backgroundSize: `${100 / c.w}% ${100 / c.h}%`, backgroundPosition: `${pos(c.x, c.w)}% ${pos(c.y, c.h)}%`, aspect: c.w / c.h }
}

export async function loadReference(blob: Blob, origin: SearchReference['origin'], crop: ReferenceCrop | null = null): Promise<SearchReference> {
  checkReferenceFile(blob)
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(blob) }
  catch { throw new ReferenceImageError('无法读取这张图片，请换一张 JPEG 或 PNG 图片') }
  const { width, height } = bitmap
  bitmap.close()
  checkReferenceSize(width, height)
  return { blob, url: URL.createObjectURL(blob), width, height, crop: crop && !isWholePicture(crop) ? normalizeCrop(crop) : null, origin }
}

export function releaseReference(reference: SearchReference | null) {
  if (reference) URL.revokeObjectURL(reference.url)
}

/** The JPEG actually searched: selection only, at most 1024 pixels on its long side. */
export async function encodeReference(reference: SearchReference): Promise<Blob> {
  const plan = referencePlan(reference.width, reference.height, reference.crop)
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(reference.blob) }
  catch { throw new ReferenceImageError('无法读取这张图片，请换一张 JPEG 或 PNG 图片') }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = plan.width; canvas.height = plan.height
    const context = canvas.getContext('2d')
    if (!context) throw new ReferenceImageError('当前浏览器无法处理图片，请换用最新版浏览器')
    // PNG transparency becomes white instead of black.
    context.fillStyle = '#fff'; context.fillRect(0, 0, plan.width, plan.height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.width, plan.height)
    for (const quality of [0.9, 0.8, 0.65]) {
      const jpeg = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!jpeg) break
      if (jpeg.size <= referenceMaxJpegBytes) return jpeg
    }
    throw new ReferenceImageError('图片细节过多，无法压缩到可搜索的大小，请框选更小的区域')
  } finally { bitmap.close() }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

import { emptyDraft, parseDraft, type PlanDraft } from './planModel'

/** 草稿只保存在本机浏览器里；接入服务器保存之前，页面上必须一直写明这一点。 */
export const DRAFT_KEY = 'ainvr.floorplan.draft.v1'

export function loadDraft(): { draft: PlanDraft; status: 'none' | 'ok' | 'invalid' } {
  try {
    const text = localStorage.getItem(DRAFT_KEY)
    if (text === null) return { draft: emptyDraft(), status: 'none' }
    const draft = parseDraft(text)
    return draft ? { draft, status: 'ok' } : { draft: emptyDraft(), status: 'invalid' }
  } catch { return { draft: emptyDraft(), status: 'none' } }
}
export function saveDraft(draft: PlanDraft): { ok: true } | { ok: false; reason: 'too_large' | 'unavailable' } {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); return { ok: true } }
  catch (e) { return { ok: false, reason: (e as Error)?.name === 'QuotaExceededError' ? 'too_large' : 'unavailable' } }
}

/** 导入底图：缩到最长边 1600 像素并转成 JPEG，避免撑爆本机存储。 */
export async function readImage(file: File): Promise<{ data: string; w: number; h: number }> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB，请先压缩')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('图片无法读取')); i.src = url })
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前浏览器不能处理图片')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h)
    for (const quality of [0.82, 0.65, 0.5]) { const data = canvas.toDataURL('image/jpeg', quality); if (data.length < 2_000_000) return { data, w, h } }
    throw new Error('图片过大，请换一张更小的图')
  } finally { URL.revokeObjectURL(url) }
}

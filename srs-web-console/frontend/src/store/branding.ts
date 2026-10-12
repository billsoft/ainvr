import { useEffect } from 'react'
import { create } from 'zustand'
import { brandingService } from '@/api/brandingService'
import type { Branding } from '@/types/branding'
import { PRODUCT } from '@/utils/product'

/**
 * OEM 品牌：整个应用只取一次（并发去重），顶栏/侧栏/关于页/登录页共用。
 * 取到之前 branding 为 null，界面不显示任何品牌——OEM 设备上不会先闪出默认品牌。
 */
const NEUTRAL_TITLE = 'AINVR'

interface BrandingState {
  branding: Branding | null
}

const useBrandingStore = create<BrandingState>(() => ({ branding: null }))
let inflight: Promise<void> | null = null

function load(): Promise<void> {
  if (useBrandingStore.getState().branding || inflight) return inflight ?? Promise.resolve()
  inflight = brandingService.get()
    .then((b) => {
      useBrandingStore.setState({ branding: b })
      document.title = b.productName || NEUTRAL_TITLE
    })
    .catch(() => {
      document.title = NEUTRAL_TITLE
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 当前品牌（取数中为 null）；首次使用即触发读取 */
export function useBranding(): Branding | null {
  const branding = useBrandingStore((s) => s.branding)
  useEffect(() => {
    void load()
  }, [])
  return branding
}

/** 界面显示的版本号：配置了 version_label 用它，否则真实版本 */
export function displayVersion(b: Branding | null): string {
  return b?.versionLabel || `v${PRODUCT.version}`
}

/** "© 2021-2026" / "© 2026"：起始年缺省或不早于今年时只写今年 */
export function copyrightYears(b: Branding | null): string {
  const now = new Date().getFullYear()
  const start = b?.copyrightStartYear
  return start && start < now ? `${start}-${now}` : String(now)
}

export function resetBrandingForTest(): void {
  useBrandingStore.setState({ branding: null })
  inflight = null
}

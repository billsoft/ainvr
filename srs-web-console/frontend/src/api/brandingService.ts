import type { Branding } from '@/types/branding'
import { request } from './httpClient'

export const brandingService = {
  /** 免登录、免授权（登录页也要显示品牌） */
  async get(): Promise<Branding> {
    const body = await request<{ code: number; data: Branding }>('/branding')
    return body.data
  },
}

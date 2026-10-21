import { create } from 'zustand'
import { request } from '@/api/httpClient'

const TOKEN_KEY = 'srs-console-token'

interface AuthState {
  token: string | null
  /** null = 还没查询过 GET /api/auth/status */
  required: boolean | null
  setupRequired: boolean
  checkStatus: () => Promise<void>
  login: (password: string, remember?: boolean) => Promise<boolean>
  handleUnauthorized: () => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem(TOKEN_KEY),
  required: null,
  setupRequired: false,

  async checkStatus() {
    try {
      const res = await request<{ code: number; data: { required: boolean; setupRequired?: boolean } }>('/auth/status')
      if(res.data.setupRequired) {
        localStorage.removeItem(TOKEN_KEY)
        set({required:true,setupRequired:true,token:null})
        return
      }
      if (!res.data.required || localStorage.getItem(TOKEN_KEY)) {
        try { await request('/auth/media-session', { method: 'POST' }) }
        catch (error) {
          if ((error as { status?: number }).status === 401) set({ required: res.data.required })
          throw error
        }
      }
      set({ required: res.data.required, setupRequired: false })
    } catch {
      // 静默失败：required 保持 null，AuthGate 显示加载态直到下次重试有结果
    }
  },

  async login(password: string, remember = false) {
    try {
      const res = await request<{ code: number; data: { token: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password, remember }),
      })
      const token = res.data.token
      localStorage.setItem(TOKEN_KEY, token)
      set({ token, required: true, setupRequired: false })
      return true
    } catch {
      return false
    }
  },

  handleUnauthorized() {
    localStorage.removeItem(TOKEN_KEY)
    set({ token: null })
  },

  logout() {
    void request('/auth/logout', { method: 'POST' }).catch(() => undefined)
    localStorage.removeItem(TOKEN_KEY)
    set({ token: null })
  },
}))

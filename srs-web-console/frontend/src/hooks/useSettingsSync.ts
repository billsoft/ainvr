import { useEffect } from 'react'
import { useSettingsStore } from '@/store/settings'

/** Refresh other administrators' changes without replacing form drafts. */
export function useSettingsSync() {
  useEffect(() => {
    let stopped = false
    let pending = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (stopped || pending) return
      clearTimeout(timer)
      pending = true
      try {
        if (!document.hidden) await useSettingsStore.getState().invalidate()
      } finally {
        pending = false
        if (!stopped) timer = setTimeout(refresh, 30000)
      }
    }
    const visible = () => { if (!document.hidden) void refresh() }
    // Existing page hooks fetch immediately; this loop also retries initial failures.
    timer = setTimeout(refresh, 30000)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('focus', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
}

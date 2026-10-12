import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LifeBuoy } from 'lucide-react'
import { remoteAssistService } from '@/api/remoteAssistService'

type View = 'hidden' | 'operating' | 'on' | 'running' | 'unconfirmed'

const label: Record<Exclude<View, 'hidden'>, string> = {
  operating: '技术支持正在远程操作',
  on: '远程协助已开启',
  running: '远程协助仍在运行',
  unconfirmed: '远程协助状态待确认',
}

/**
 * 顶栏提醒：远程协助长期开启时持续可见，避免客户忘记关闭。
 * 只有明确读到"已关闭且已停止"才隐藏；之前显示过而本次查询失败（后端重启、
 * 登录过期等，宿主机隧道并不会因此停止）时保留提醒并改为"状态待确认"。
 * 已连接且有远程连接时显示"技术支持正在远程操作"（与远程协助页同一判据）。
 */
export function RemoteAssistIndicator() {
  const [view, setView] = useState<View>('hidden')
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (!document.hidden) {
        try {
          const s = await remoteAssistService.getStatus()
          if (!cancelled) setView(s.state === 'unknown' ? 'unconfirmed'
            : s.state === 'connected' && s.sessions > 0 ? 'operating'
              : s.enabled ? 'on' : s.running ? 'running' : 'hidden')
        } catch {
          if (!cancelled) setView(previous => previous === 'hidden' ? 'hidden' : 'unconfirmed')
        }
      }
      if (!cancelled) timer = setTimeout(poll, 15000)
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [])
  if (view === 'hidden') return null
  return <Link to="/config-center?category=remote-assist" title={`${label[view]}，点击查看或关闭`}
    className={`ml-3 flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ${view === 'operating' ? 'bg-danger-50 text-danger-700' : 'bg-amber-50 text-amber-800'}`}>
    <LifeBuoy size={14} aria-hidden /><span>{label[view]}</span>
  </Link>
}

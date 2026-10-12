import { useCallback, useEffect, useRef, useState } from 'react'
import { configService, type ApplyOperation, type ConfigChange } from '@/api/configService'

/** One save contract for configuration forms and playback recording schedules. */
export function useConfigApply(enabled = true) {
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [remaining, setRemaining] = useState(480)
  const [outcome, setOutcome] = useState('')
  const generation = useRef(0)
  const active = useRef(false)
  const follow = useCallback(async (initial: ApplyOperation, token: number) => {
    let job = initial
    const deadline = Math.min(initial.deadline, Date.now() + 480_000)
    while (job.status === 'running') {
      if (generation.current !== token) throw new Error('页面已离开，后台仍继续更新')
      if (Date.now() >= deadline) throw new Error('等待更新超时，页面已解锁；后台可能仍在应用，请稍后检查状态')
      setStage(job.stage)
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)))
      await new Promise(resolve => setTimeout(resolve, 1500))
      const next = await configService.getApplyOperation(initial.id)
      if (!next || next.id !== initial.id) throw new Error('更新状态已变化或后台已重启，请重新进入页面确认配置')
      job = next
    }
    if (generation.current !== token) throw new Error('页面已离开')
    setOutcome(job.stage)
    if (job.status !== 'succeeded') throw new Error(job.stage)
  }, [])
  useEffect(() => {
    const token = ++generation.current
    active.current = false
    setBusy(false)
    if (enabled) void configService.getApplyOperation().then(async job => {
      if (generation.current !== token || active.current || job?.status !== 'running') return
      active.current = true
      setBusy(true)
      try { await follow(job, token) }
      catch (e) { if (generation.current === token) setOutcome(e instanceof Error ? e.message : '更新失败') }
      finally { if (generation.current === token) { active.current = false; setBusy(false) } }
    }).catch(() => { /* Saving checks the authoritative server lock again. */ })
    return () => { ++generation.current }
  }, [enabled, follow])
  const apply = useCallback(async (changes: ConfigChange[]) => {
    if (active.current) throw new Error('正在更新，请稍候')
    const token = generation.current
    active.current = true
    setBusy(true); setStage('正在校验并保存配置'); setOutcome(''); setRemaining(480)
    try { await follow(await configService.applyChanges(changes), token) }
    catch (e) {
      if (generation.current === token) setOutcome(e instanceof Error ? e.message : '更新失败，页面已解锁')
      throw e
    } finally { if (generation.current === token) { active.current = false; setBusy(false) } }
  }, [follow])
  return { apply, busy, stage, remaining, outcome }
}

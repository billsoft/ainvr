import { useEffect, useRef } from 'react'

export interface UsePollingOptions {
  /** 每次 tick 结束后调用，判断"这次算不算失败"——不改变 fn 本身的调用
   * 契约（fn 依然只管做事，失败与否交给调用方自己落进某个 store 状态位
   * 再从这里读出来），轮询机制本身不关心"失败"具体是什么含义。缺省视为
   * 从不失败，行为与不传 options 完全一致（向后兼容）。 */
  isFailing?: () => boolean
  /** 连续失败时最多把 intervalMs 放大到几倍（指数退避，2^连续失败次数，
   * 封顶这个倍数）。默认 8——例如 5s 基础间隔在持续失败时最终稳定在 40s，
   * 不会一直用原始频率空转打服务不可达的接口。 */
  maxBackoffMultiplier?: number
}

/**
 * 通用轮询 hook：按 intervalMs 间隔重复调用 fn；页面不可见（切后台标签/
 * 最小化）时暂停，重新可见时立即执行一次再重排 interval——不是"存在感知
 * 但仍然定时空转"，是真的暂停网络请求。
 *
 * 与 useSystemStatus.ts 的既有轮询模式（setTimeout 递归 + cancelled 标记）
 * 保持同一种实现风格，不引入 setInterval 这种不同的计时原语。
 *
 * 失败退避是可选的（`options.isFailing`）：不传时行为与之前完全一致
 * （恒定频率轮询）——AI 通道页会传，让"服务持续不可达"时的轮询自动放慢，
 * 不用恒定频率一直打一个已知连不上的接口。
 */
export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
  options?: UsePollingOptions,
) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let consecutiveFailures = 0

    async function tick() {
      // ⚠️ 提前 return 分支必须把 timer 复位为 null——否则上一轮 setTimeout
      // 触发时残留的非 null timer 会一直留着，等页面重新可见时
      // handleVisibilityChange 的 `else if (!timer)` 判断永远为假，
      // 恢复分支再也不会被调用，轮询死循环般地静默停摆（回归见 usePolling.test.ts）。
      if (cancelled || document.hidden) {
        timer = null
        return
      }
      try {
        await fnRef.current()
      } catch {
        // fn 抛异常也不能让下面的重新排期跳过——不管是否抛错，只要
        // 组件还没卸载就必须继续排下一次 tick，否则轮询从此永久停摆。
        // 具体的失败状态（如"服务不可达"）交给 fn 自己落进对应 store，
        // 这里只保证"轮询本身不会被一次异常打死"。
      }

      const isFailing = optionsRef.current?.isFailing?.() ?? false
      consecutiveFailures = isFailing ? consecutiveFailures + 1 : 0

      // await 期间可能已经切到后台（handleVisibilityChange 清掉了 timer），
      // 这里要重新判断一次 document.hidden，不能无条件排下一次 tick——
      // 否则会在页面隐藏时排出一个"表面存在、实际到点也不会做事"的定时器，
      // 且它到点触发时命中上面的提前 return，页面重新可见时同样恢复不了。
      if (!cancelled && !document.hidden) {
        const maxMultiplier = optionsRef.current?.maxBackoffMultiplier ?? 8
        const multiplier = isFailing ? Math.min(2 ** consecutiveFailures, maxMultiplier) : 1
        timer = setTimeout(tick, intervalMs * multiplier)
      }
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      } else if (!timer) {
        // 重新可见：立即执行一次，不等下一个 interval
        tick()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    tick()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [intervalMs, enabled])
}

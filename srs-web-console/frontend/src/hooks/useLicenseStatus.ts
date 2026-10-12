import { useEffect } from 'react'
import { usePolling } from './usePolling'
import { useLicenseStore } from '@/store/license'

/**
 * 授权状态轮询：挂载即拉机器码 + 状态，之后每 pollMs 秒校准一次。
 * 倒计时的秒级走时由展示组件本地计时，这里只做分钟级校准，
 * 避免倒计时把网络轮询频率绑死。
 */
export function useLicenseStatus(pollMs = 10_000) {
  const status = useLicenseStore((s) => s.status)
  const statusAt = useLicenseStore((s) => s.statusAt)
  const loading = useLicenseStore((s) => s.statusLoading)
  const unreachable = useLicenseStore((s) => s.statusUnreachable)
  const machineCode = useLicenseStore((s) => s.machineCode)
  const machineCodeLoading = useLicenseStore((s) => s.machineCodeLoading)
  const machineCodeUnreachable = useLicenseStore((s) => s.machineCodeUnreachable)
  const refreshStatus = useLicenseStore((s) => s.refreshStatus)
  const refreshMachineCode = useLicenseStore((s) => s.refreshMachineCode)

  useEffect(() => {
    void refreshMachineCode()
  }, [refreshMachineCode])

  usePolling(() => refreshStatus(true), pollMs)

  return {
    status,
    statusAt,
    loading,
    unreachable,
    machineCode,
    machineCodeLoading,
    machineCodeUnreachable,
    refreshStatus,
    refreshMachineCode,
  }
}

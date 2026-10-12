import { useLicenseStatus } from '@/hooks/useLicenseStatus'
import { useEffect } from 'react'
import { useLicenseStore } from '@/store/license'
import { LicenseStatusCard } from './LicenseStatusCard'
import { MachineCodeCard } from './MachineCodeCard'
import { ActivateForm } from './ActivateForm'
import { RemoveLicenseForm } from './RemoveLicenseForm'
import { LicenseEventsCard } from './LicenseEventsCard'

export default function LicensePage({ embedded = false }: { embedded?: boolean }) {
  // 机器码刷新直接走 store：与 hook 内部用的是同一个 action，
  // 这里显式取避免页面刷新按钮间接依赖轮询 hook 的返回面。
  const refreshMachineCode = useLicenseStore((s) => s.refreshMachineCode)
  const {
    status,
    statusAt,
    loading,
    unreachable,
    machineCode,
    machineCodeLoading,
    machineCodeUnreachable,
  } = useLicenseStatus(10_000)
  const events = useLicenseStore((s) => s.events)
  useEffect(() => { void refreshMachineCode() }, [refreshMachineCode, status?.state, status?.grant_seq])

  return (
    <section aria-labelledby="license-title" className="mx-auto max-w-4xl space-y-6">
      <header>
        {embedded ? <h2 id="license-title" className="text-lg font-semibold text-ink">授权管理</h2> : <h1 id="license-title" className="page-title">授权管理</h1>}
        <p className="page-description">查看本机授权状态、录入注册码，授权与本机硬件绑定（一机一码）</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <LicenseStatusCard status={status} statusAt={statusAt} loading={loading} unreachable={unreachable} />
        <MachineCodeCard
          machineCode={machineCode}
          loading={machineCodeLoading}
          unreachable={machineCodeUnreachable}
          onRefresh={() => void refreshMachineCode()}
        />
      </div>

      <ActivateForm />
      <RemoveLicenseForm />
      <LicenseEventsCard events={events} />
    </section>
  )
}

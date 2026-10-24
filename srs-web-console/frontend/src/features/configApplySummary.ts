import type { ApplyOperation, ServiceState } from '@/api/configService'

/** A past successful operation must not hide today's pending/failed service. */
export function configApplySummary(states: ServiceState[], operation: ApplyOperation | null,
  services: string[], error = ''): { text: string; tone: 'success' | 'running' | 'warning' } {
  if (error) return { text: '配置应用状态暂时不可用', tone: 'warning' }
  if (operation?.status === 'running') return { text: operation.stage, tone: 'running' }
  if (operation?.status === 'failed' || operation?.status === 'timeout') {
    return { text: operation.stage, tone: 'warning' }
  }
  if (states.some(s => services.includes(s.serviceName) && s.status === 'failed')) {
    return { text: '部分服务应用失败，请检查下方状态', tone: 'warning' }
  }
  if (services.every(name => {
    const s = states.find(v => v.serviceName === name)
    return s?.status === 'applied' && !s.restartRequired && s.appliedVersion != null &&
      s.appliedVersion === s.desiredVersion
  })) return { text: '当前配置已应用', tone: 'success' }
  return { text: '部分服务尚未确认生效，请检查下方状态', tone: 'warning' }
}

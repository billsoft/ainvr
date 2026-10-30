/** 每个面板标明真实数据从哪来，避免示例数字被当成已经能统计的结论。 */
const KINDS = {
  live: { text: '真实计数', cls: 'bg-primary-50 text-primary' },
  ready: { text: '可接入现有计数', cls: 'bg-success-50 text-success-700' },
  needs: { text: '需新增采集', cls: 'bg-amber-50 text-warning' },
  pending: { text: '待验证', cls: 'bg-surface-page text-ink-subtle' },
} as const

export function DataTag({ kind }: { kind: keyof typeof KINDS }) {
  const k = KINDS[kind]
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-normal ${k.cls}`}>{k.text}</span>
}

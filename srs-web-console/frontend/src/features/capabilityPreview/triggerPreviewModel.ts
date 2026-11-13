// UI-only design examples. These types never enter the alarm API contract.
export type PreviewScene = 'helmet' | 'fire' | 'understaffed' | 'fall' | 'pose'
export interface PreviewDraft {
  scene: PreviewScene
  durationSeconds: string
  recoverySeconds: string
  minimumPeople: string
  fireTarget: 'either' | 'smoke' | 'fire'
}
export const sceneTemplates: { id: PreviewScene; name: string; help: string; dependencies: string[]; caution: string }[] = [
  { id: 'helmet', name: '安全帽', help: '未戴安全帽',
    dependencies: ['明确的未戴安全帽检测标签（no_helmet）', '区域连续有效观测与现场验证'],
    caution: '仅支持明确的 no_helmet 标签。仅有 helmet / head 的模型不支持此模板，head 不等于未戴帽；未检出帽子也不能推断未戴帽。候选需现场验证和人工审核。' },
  { id: 'fire', name: '烟火', help: '出现烟雾或明火',
    dependencies: ['烟雾 / 明火检测', '区域持续、恢复与证据片段'],
    caution: '按同一规则、同一区域形成持续事件，不依赖烟雾轨迹 ID；单次闪光不能证明持续烟火，也不等于已确认火灾。' },
  { id: 'understaffed', name: '区域人数不足', help: '区域人数不足',
    dependencies: ['人员检测与跟踪去重', '区域有效观测覆盖与状态判定'],
    caution: '人数为检测/跟踪观测人数，不是真实唯一人数或进出累计余额。断流、检测未运行或跟踪/关联不确定不按无人处理；完全未检出的遮挡仍需现场验证，不能据此认定员工离岗。' },
  { id: 'fall', name: '疑似倒地', help: '有人疑似倒地',
    dependencies: ['17 点姿态适配与人形关联', '关键点可见度、机位校验及连续证据'],
    caution: '只预览疑似倒地状态；不证明跌倒过程。坐下、弯腰、机位投影或关联歧义必须排除，不能靠一个躯干角度确认。' },
  { id: 'pose', name: '姿态试验', help: '只观察，不形成告警',
    dependencies: ['17 点姿态适配', '同帧人员关联、可见度与视角校验'],
    caution: '实验性观测，不承诺睡岗、攀爬、跌倒等动作识别；五点人脸坐标不能替代 17 点姿态。' },
]
export function createPreviewDraft(scene: PreviewScene = 'helmet'): PreviewDraft {
  return { scene, durationSeconds: scene === 'understaffed' ? '30' : '5', recoverySeconds: '5', minimumPeople: '1', fireTarget: 'either' }
}
const secondsValid = (value: string) => value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0.1 && Number(value) <= 3600 && Math.abs(Number(value) * 1000 - Math.round(Number(value) * 1000)) < 1e-7
export function draftError(draft: PreviewDraft): string {
  if (draft.scene !== 'pose' && (!secondsValid(draft.durationSeconds) || !secondsValid(draft.recoverySeconds))) return '持续和恢复时间须为 0.1–3600 秒，最多三位小数。此范围仅用于设计预览。'
  if (draft.scene === 'understaffed' && (!draft.minimumPeople.trim() || !Number.isInteger(Number(draft.minimumPeople)) || Number(draft.minimumPeople) < 1 || Number(draft.minimumPeople) > 1000)) return '人数下限须为 1–1000 的整数；下限 1 表示有效观测下连续无人。'
  return ''
}
export function previewSummary(draft: PreviewDraft): string {
  if (draftError(draft)) return '请补全有效条件后查看摘要与模拟。'
  if (draft.scene === 'pose') return '在原布防区域内查看可关联的 17 点姿态与质量；只做试验观测，不创建业务告警。'
  const condition = draft.scene === 'helmet' ? '发现未戴安全帽的人员'
    : draft.scene === 'fire' ? `发现${draft.fireTarget === 'smoke' ? '烟雾' : draft.fireTarget === 'fire' ? '明火' : '烟雾或明火'}`
    : draft.scene === 'understaffed' ? `人数少于 ${Number(draft.minimumPeople)} 人${Number(draft.minimumPeople) === 1 ? '（无人）' : ''}`
    : '有人呈倒地姿态'
  return `在布防区域内，${condition}，持续 ${Number(draft.durationSeconds)} 秒后产生一条告警；恢复正常并保持 ${Number(draft.recoverySeconds)} 秒后告警结束，再次出现才会产生新告警。画面中断或看不清的时段不计时。`
}
export type ObservationQuality = 'valid' | 'unavailable' | 'stale' | 'ambiguous'
export interface SimulatedObservation {
  quality: ObservationQuality
  intervalMs: number
  candidate: boolean
  people: number | null
}
export interface PreviewSimulation {
  phase: 'idle' | 'normal' | 'pending' | 'active' | 'recovering' | 'unknown' | 'observation'
  pendingMs: number
  recoveryMs: number
  episodeOpen: boolean
  episodes: number
  detail: string
}
export const initialSimulation = (): PreviewSimulation => ({ phase: 'idle', pendingMs: 0, recoveryMs: 0, episodeOpen: false, episodes: 0, detail: '尚未模拟。每次操作代表一段连续有效覆盖的时间区间，不是单帧或真实视频。' })
// A deliberately conservative storyboard, not a production rules engine:
// unknown breaks continuity but preserves an open episode until valid recovery.
export function simulateObservation(previous: PreviewSimulation, draft: PreviewDraft, observation: SimulatedObservation): PreviewSimulation {
  if (draftError(draft) || !Number.isInteger(observation.intervalMs) || observation.intervalMs < 100 || observation.intervalMs > 3600000) return { ...previous, detail: '模拟输入无效；未推进状态。' }
  if (observation.quality !== 'valid' || (draft.scene === 'understaffed' && (observation.people === null || !Number.isInteger(observation.people) || observation.people < 0 || observation.people > 1000))) {
    return { ...previous, phase: 'unknown', pendingMs: 0, recoveryMs: 0, detail: `观测未知（unknown）；人数不可当作 0，缺口不累计有效持续或恢复时间。恢复观测后重新累计连续窗口。${previous.episodeOpen ? '保留同一候选事件，不宣布风险解除，不重复计数。' : '不形成候选事件。'}` }
  }
  if (draft.scene === 'pose') return { ...initialSimulation(), phase: 'observation', detail: '模拟姿态观测有效；仅检查 17 点与人员关联，不产生业务告警。' }
  const matches = draft.scene === 'understaffed' ? observation.people! < Number(draft.minimumPeople) : observation.candidate
  if (matches) {
    if (previous.episodeOpen) return { ...previous, phase: 'active', pendingMs: previous.pendingMs + observation.intervalMs, recoveryMs: 0, detail: '条件仍满足，沿用同一候选事件；不会每帧重复形成事件。' }
    const pendingMs = previous.pendingMs + observation.intervalMs
    if (pendingMs >= Math.round(Number(draft.durationSeconds) * 1000)) return { phase: 'active', pendingMs, recoveryMs: 0, episodeOpen: true, episodes: previous.episodes + 1, detail: '有效持续时间达到条件：预期形成一个候选事件。仅为模拟，未生成真实告警。' }
    return { ...previous, phase: 'pending', pendingMs, recoveryMs: 0, detail: '条件满足，但连续有效持续时间尚不足；继续积累，不形成事件。' }
  }
  if (previous.episodeOpen) {
    const recoveryMs = previous.recoveryMs + observation.intervalMs
    if (recoveryMs >= Math.round(Number(draft.recoverySeconds) * 1000)) return { ...previous, phase: 'normal', pendingMs: 0, recoveryMs: 0, episodeOpen: false, detail: '有效观测连续恢复达到条件：预期结束当前候选事件。再次满足需重新累计。' }
    return { ...previous, phase: 'recovering', pendingMs: 0, recoveryMs, detail: '正在累计有效恢复时间；仍属于原候选事件，短暂不满足不会反复告警。' }
  }
  return { ...previous, phase: 'normal', pendingMs: 0, recoveryMs: 0, detail: '有效观测下条件不满足；连续窗口归零，不形成候选事件。' }
}

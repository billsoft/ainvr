/** 第一阶段只开放目标跟踪与实时轨迹显示。区域规则与事件、大模型复核、报警通知
 * 的代码和用户已保存的配置都保留，但界面不挂载、服务端不运行（见 ai-service
 * analytics::PhaseEffective）。开放某项时须前后端同时打开并重新验收。 */
export const ANALYTICS_PHASE = {
  rulesAndEvents: false,
  review: false,
  notification: false,
} as const

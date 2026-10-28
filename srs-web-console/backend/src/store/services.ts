/**
 * 配置中心服务名单（唯一权威定义）
 *
 * 此前服务列表在 4 处各自硬编码（pgStore.publish / pgStore.rollbackToVersion /
 * migrations 初始数据 / 前端 ConfigCenter），且 service-states upsert 无白名单，
 * 任意名字都能插入（testsvc/verify 测试残留即由此进入生产表）。
 * 现在统一从本模块导入；前端因跨包不能直接 import，保持同名常量并在
 * ConfigCenter/index.tsx 注释指回本文件。
 *
 * ⚠️ 新增服务时：此处加名字 + 对应 adapter（或 PullModeAdapter），二者缺一不可。
 */
export const CONFIG_SERVICES = ['backend', 'srs', 'ai-service', 'recorder', 'alarm-service', 'llm-service', 'search-service'] as const;

export type ConfigServiceName = (typeof CONFIG_SERVICES)[number];

export function isConfigService(name: unknown): name is ConfigServiceName {
  return typeof name === 'string' && (CONFIG_SERVICES as readonly string[]).includes(name);
}

/**
 * 服务间令牌 → 服务身份绑定（2026-09-15 B 系列收尾，评审定稿）
 *
 * 演进：A2 时全线共享单个 CONFIG_SERVICE_TOKEN（已声明的局限）——任一持
 * token 的服务都能在拉取快照时把 ?service= 改成别的服务，冒充它拉取
 * secrets。现在改为每服务独立 token，token 推导服务身份，?service= 与
 * 绑定服务不一致一律 403。
 *
 * token 在 srs-web-console/.env 定义（生成：openssl rand -hex 24），通过
 * docker-compose 传给 backend 容器、通过 systemd unit 传给各微服务。
 */
import crypto from 'node:crypto';
import type { ConfigServiceName } from '../store/services.js';

const ENV_BY_SERVICE: Record<ConfigServiceName, string> = {
  backend: 'CONFIG_SERVICE_TOKEN_BACKEND',
  srs: 'CONFIG_SERVICE_TOKEN_SRS',
  'ai-service': 'CONFIG_SERVICE_TOKEN_AI_SERVICE',
  recorder: 'CONFIG_SERVICE_TOKEN_RECORDER',
  'alarm-service': 'CONFIG_SERVICE_TOKEN_ALARM_SERVICE',
};

/** token 值 → 服务名。启动时从 env 加载一次。 */
export function loadServiceTokens(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();
  for (const [svc, envName] of Object.entries(ENV_BY_SERVICE)) {
    const t = (env[envName] ?? '').trim();
    if (t) map.set(t, svc);
  }
  return map;
}

/** 常量时间比较解析 token 对应的服务；无效/未匹配返回 undefined */
export function resolveServiceByToken(
  tokens: Map<string, string>,
  token: unknown,
): string | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const tokenBuf = Buffer.from(token);
  for (const [t, svc] of tokens) {
    const ref = Buffer.from(t);
    if (ref.length === tokenBuf.length && crypto.timingSafeEqual(ref, tokenBuf)) {
      return svc;
    }
  }
  return undefined;
}

/** 请求是否携带任一有效服务 token（用于 /api/v1/config/* 放行判断） */
export function isServiceTokenValid(tokens: Map<string, string>, token: unknown): boolean {
  return resolveServiceByToken(tokens, token) !== undefined;
}

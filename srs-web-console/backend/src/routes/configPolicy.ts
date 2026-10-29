/**
 * 统一配置中心 API 路由（/api/v1/config/...）
 *
 * 第 2 步完整实现：
 * - 配置文档 CRUD
 * - 发布编排（逐服务下发 + 部分成功 + 状态记录 + 审计）
 * - 回滚编排（逐服务回滚 + 验证）
 * - 配置校验（发布前预校验）
 * - 导入/导出
 * - 服务状态查询 & 上报
 * - 审计日志查询
 * - 敏感值管理（永远不返回明文）
 * - 漂移检测
 */
import { FastifyPluginOptions } from 'fastify';
import crypto from 'node:crypto';
import type { PgConfigStore } from '../store/pgStore.js';
import type { PublishOrchestrator } from '../store/publishOrchestrator.js';
import { ADMIN_PASSWORD_SECRET_KEY } from '../services/adminPasswordMigration.js';
import type { SearchModelMigrationRouteOptions } from './searchModelMigrationRoutes.js';
import type { prepareSearchModelMigrationActivation } from '../services/searchModelMigrationActivation.js';
import type {SearchJob} from '../store/searchJobs.js';
import type {SearchMigrationPlanArtifacts} from '../services/searchModelMigrationPlanArtifacts.js';

export interface ConfigRoutesOptions extends FastifyPluginOptions {
  pgStore: PgConfigStore;
  orchestrator: PublishOrchestrator;
  /** 服务 token → 服务名绑定（每服务独立，防冒充拉别家 secrets）。
   *  未配置时快照解密功能整体关闭（占位符永不解析）。 */
  serviceTokens?: Map<string, string>;
  aiServiceBaseUrl?: string;
  readBackendSettings?: () => Promise<import("../types/channel.js").AppSettings>;
  searchMigrations?: Omit<SearchModelMigrationRouteOptions,'activate'|'apply'|'publishPlan'|'restorePlan'> & {
    prepareActivation: typeof prepareSearchModelMigrationActivation;
    activationStore: Parameters<typeof prepareSearchModelMigrationActivation>[1]['store'];
    onPlanApplyReady?:(bindings:{publish:(job:SearchJob,proof:SearchMigrationPlanArtifacts,signal:AbortSignal)=>Promise<void>;
      restore:(job:SearchJob,signal:AbortSignal)=>Promise<void>})=>void;
  };
}

/** ${secret:key} 占位符：配置文档里敏感值只存引用，明文只在 PG config_secrets
 *  （AES-256-GCM 密文）；服务拉取时由 BFF 解密替换，浏览器/导出永远只见引用。 */
export const SECRET_REF_RE = /^\$\{secret:([^}]+)\}$/;

/** 深遍历解析文档里的 ${secret:key} 占位符。
 *  安全约束（A2 评审）：key 必须以本服务名/ 前缀开头——跨服务引用一律置 null
 *  并告警，不给服务越权拉别人 secrets 的机会；未设置的 secret 解析为 null。 */
export async function resolveSecretRefs(
  node: unknown,
  service: string,
  getSecret: (key: string) => Promise<string | null>,
): Promise<void> {
  if (Array.isArray(node)) {
    for (const item of node) await resolveSecretRefs(item, service, getSecret);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const m = SECRET_REF_RE.exec(v);
        if (!m) continue;
        const key = m[1]!;
        if (!key.startsWith(`${service}/`)) {
          console.warn(`[config] 服务 ${service} 试图引用越权 secret「${key}」，已置 null`);
          obj[k] = null;
          continue;
        }
        obj[k] = await getSecret(key);
      } else {
        await resolveSecretRefs(v, service, getSecret);
      }
    }
  }
}

/** 导入时已知敏感路径 → config_secrets key 的映射（按服务）。
 *  ⚠️ 路径以各服务实际导出的 JSON 字段名为准（snake_case / camelCase 都列出来）。
 *  明文会被剥出来写入 secrets，文档里替换成 ${secret:...} 占位符。
 *
 *  ⚠️ 不要把 backend/adminPasswordHash 加回这里！它不是"一般敏感值"——
 *  它本身就是 X-Console-Token 鉴权凭据（sha256(密码) 直接当 token 比对，
 *  见 auth.ts），"清洗后转存 secrets" 这套逻辑对它是错的：等于把「未经
 *  服务端重新哈希的任意值」直接采信成新的登录令牌。它只能通过
 *  PUT /api/settings 的专用改密码流程写入（那条路径从明文密码在服务端
 *  重新算哈希）。这里改用 rejectReservedAdminPasswordField() 显式拒绝，
 *  见下方定义处的完整说明。 */
export const KNOWN_SECRET_PATHS: Record<string, string[][]> = {
  'search-service': [['callers', '*', 'key']],
  'llm-service': [['admin_key'], ['api_keys', '*', 'key']],
  'alarm-service': [['mongo_uri'], ['api_token'], ['producer_token']],
  recorder: [
    ['storage', 'smb', 'password'],
  ],
  'ai-service': [
    ['snapshot_store', 'mongo_uri'],
    ['snapshot_store', 'mongo_readonly_password'],
    // Python 端 AppConfig 用 snake_case（server.api_key），与 ai-service/config.py 一致
    ['server', 'api_key'],
    // 同时支持 camelCase 形式（前端/文档可能混用），统一映射到同一个 secret key
    ['server', 'apiKey'],
  ],
};

/** 把字段路径转成 secret key（统一用点连接，与 BFF 按服务过滤解密的约定一致：<service>/<dot.path>） */
export function pathToSecretKey(service: string, path: string[]): string {
  // 统一 snake_case 形式作为 key（以服务实际 schema 为准）
  // ai-service 的 apiKey 别名统一映射到 api_key 的 key
  if (service === 'ai-service' && path.join('.') === 'server.apiKey') {
    return `${service}/server.api_key`;
  }
  return `${service}/${path.join('.')}`;
}

/** Expand only declared array wildcards; never discover secrets by field name. */
function concreteSecretPaths(config: unknown, patterns: string[][]): string[][] {
  const result: string[][] = [];
  function visit(node: unknown, remaining: string[], path: string[]) {
    if (!remaining.length) { result.push(path); return; }
    const [head, ...tail] = remaining;
    if (head === '*') {
      if (Array.isArray(node)) node.forEach((value, index) => visit(value, tail, [...path, String(index)]));
    } else if (node && typeof node === 'object') {
      visit((node as Record<string, unknown>)[head!], tail, [...path, head!]);
    }
  }
  for (const pattern of patterns) visit(config, pattern, []);
  return result;
}

/** 导入文档的敏感值清洗：把已知明文敏感字段写入 secrets，返回替换了 ${secret:...} 占位符的新 config。
 *  已有占位符引用（以 ${secret: 开头）原样保留。
 *  ⚠️ 支持传入 PoolClient，保证同一事务内写文档 + 写 secrets（否则回滚时会留下孤儿 secret）。 */
export async function sanitizeImportDocSecrets(
  service: string,
  config: Record<string, unknown>,
  pgStore: PgConfigStore,
  actor: string,
  client?: import('pg').PoolClient,
): Promise<Record<string, unknown>> {
  const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const paths = concreteSecretPaths(cloned, KNOWN_SECRET_PATHS[service] ?? []);

  for (const path of paths) {
    let cur: Record<string, unknown> | undefined = cloned;
    for (let i = 0; i < path.length - 1; i++) {
      cur = cur?.[path[i]!] as Record<string, unknown> | undefined;
      if (!cur || typeof cur !== 'object') { cur = undefined; break; }
    }
    if (!cur) continue;
    const lastKey = path[path.length - 1]!;
    const val = cur[lastKey];

    // 已有占位符引用 → 跳过（保持原样）
    if (typeof val === 'string' && SECRET_REF_RE.test(val)) continue;

    // 明文非空 → 写入 secrets + 替换占位符
    if (typeof val === 'string' && val.length > 0) {
      // URI/password snapshots must remain immutable while a new draft waits
      // for AI restart. Keep server.api_key's established canonical contract.
      const versioned = ['alarm-service', 'llm-service', 'search-service'].includes(service) ||
        (service === 'ai-service' && path[0] === 'snapshot_store' &&
          ['mongo_uri', 'mongo_readonly_password'].includes(path[1] ?? ''));
      const secretKey = pathToSecretKey(service, path) + (versioned ? '/' + crypto.randomUUID() : '');
      if (client) {
        // 同一事务内写：加锁避免并发，用相同的加密方式
        const ciphertext = await pgStore.encryptSecret(val);
        await client.query(
          `INSERT INTO config_secrets (key_path, ciphertext, algorithm, key_version)
           VALUES ($1, $2, 'aes-256-gcm', 1)
           ON CONFLICT (key_path) DO UPDATE
             SET ciphertext = EXCLUDED.ciphertext,
                 updated_at = now()`,
          [secretKey, ciphertext],
        );
      } else {
        await pgStore.setSecret(secretKey, val, actor);
      }
      cur[lastKey] = `\${secret:${secretKey}}`;
    }
  }

  return cloned;
}

/** 疑似敏感字段名：如果出现在未知路径上且值为非空字符串，拒绝导入。
 *  覆盖 camelCase + snake_case 常见变体，防止未来新增敏感字段忘了加 KNOWN_SECRET_PATHS。 */
export const SUSPECT_SENSITIVE_KEYS = /^(password|passwd|pwd|secret|token|api_key|apikey|apiKey|auth_key|private_key|privateKey|client_secret|clientSecret|access_key|accessKey|secret_key|secretKey)$/i;

/** 深校验：未知疑似敏感字段拒绝导入，返回错误描述；通过返回 null。 */
export function validateNoSensitiveFields(
  config: Record<string, unknown>,
  service: string,
): string | null {
  const knownPaths = new Set(
    concreteSecretPaths(config, KNOWN_SECRET_PATHS[service] ?? []).map((p) => p.join('.')),
  );

  function walk(node: unknown, path: string[]): string | null {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        const err = walk(item, [...path, String(index)]);
        if (err) return err;
      }
      return null;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const nextPath = [...path, k];
        const pathStr = nextPath.join('.');
        // 已知敏感路径（已被上一步清洗过，到这里应该是 ${secret:...} 引用或空）
        if (knownPaths.has(pathStr)) continue;
        // 疑似敏感字段名 + 非空字符串 → 拒绝
        if (SUSPECT_SENSITIVE_KEYS.test(k) && typeof v === 'string' && v.length > 0
            && !SECRET_REF_RE.test(v)) {
          return `疑似敏感字段「${pathStr}」含明文，拒绝导入。请先设置为 ${'$'}{secret:...} 引用或清空。`;
        }
        const err = walk(v, nextPath);
        if (err) return err;
      }
    }
    return null;
  }

  return walk(config, []);
}

/** 2026-09-16 安全复核发现的收口：backend/system/settings 文档里的
 *  adminPasswordHash 字段必须整体拒绝通过通用配置接口写入（无论是交互式
 *  的 POST /v1/config/documents 整文档 UPSERT，还是 POST /v1/config/import）。
 *
 *  背景：B4 把 adminPasswordHash 迁到了 config_secrets（key=
 *  ADMIN_PASSWORD_SECRET_KEY），文档字段迁移后恒为空，读路径（status.ts
 *  的 AppSettingsSchema）也不再声明该字段、解析时静默丢弃——这部分对
 *  「读」是安全的。但「写」这一侧，本文件里两条通用路径都是直接把调用方
 *  提供的 JSON 原样落库（POST /v1/config/documents 完全不做字段级校验；
 *  import 只对 KNOWN_SECRET_PATHS 里登记的路径做清洗，之前 backend 那条
 *  登记恰好会把任意明文值当成「合法密码哈希」直接转存进
 *  config_secrets["backend/adminPasswordHash"]——等于绕开 PUT /api/settings
 *  那条唯一受信任、会从明文密码在服务端重新计算哈希的改密码流程，任何能
 *  调用这两个接口的人都能塞入一个自己选的哈希值，下一次 passwordCache
 *  刷新（≤2s）就会把它当成新的 X-Console-Token 校验基准）。
 *
 *  这里不做「清洗转存」，直接拒绝——密码只能走 PUT /api/settings。 */
export function rejectReservedAdminPasswordField(
  service: string,
  group: string,
  name: string,
  config: Record<string, unknown>,
): string | null {
  if (service !== 'backend' || group !== 'system' || name !== 'settings') return null;
  if (!('adminPasswordHash' in config)) return null;
  const val = config.adminPasswordHash;
  if (val === undefined || val === null || val === '') return null;
  return 'backend/system/settings 文档不支持写入 adminPasswordHash 字段——它是登录凭据本身，只能通过 PUT /api/settings 的改密码流程修改，不支持通用配置接口。';
}

/** 2026-09-16 安全复核：service token 只能碰归属它自己的资源，不是整个
 *  配置中心的管理员权限。
 *
 *  此前 app.ts 的 onRequest 钩子对任一有效 service token 放行"整个"
 *  /api/v1/config/* 前缀，身份收窄只在两条路由（快照拉取 + 状态上报）
 *  里各自内联实现，其余全部写路由（改写/删除任意服务的文档与密钥、
 *  触发全局发布/回滚）对四个微服务的 token 一视同仁——任一台微服务主机
 *  的 token 泄露（环境变量/进程被攻破）就等于拿到整个配置中心的管理员
 *  权限，而这条路径此前零测试覆盖。
 *
 *  现在 onRequest 钩子只解析身份、挂到 req.boundService 上，真正的收窄
 *  在这里做：resourceService 传具体服务名，要求 token 绑定的服务与之一致；
 *  传 null 表示"全局操作"（发布/回滚/导入导出/审计日志/漂移检测/版本
 *  列表），service token 一律拒绝——这些操作跨越多个服务，无法归属到
 *  单一服务，只应由控制台管理员（console token，或未设密码时的开放模式）
 *  触发。req.boundService 为 undefined 表示走的是 console token 鉴权
 *  （或未设密码），视为完整权限，不做进一步限制。
 *
 *  GET /v1/config/versions/:version/snapshot 与 POST /v1/config/service-states/:service
 *  这两条路由是 recorder/ai-service 拉配置客户端实际在用的（轮询
 *  desiredVersion、拉本服务快照），各自已有内联的按服务比对逻辑，
 *  不经过这个通用 helper，改动时需要保持它们继续可用。 */
export function serviceScopeError(
  req: { boundService?: string },
  resourceService: string | null,
): { code: number; error: string } | null {
  const bound = req.boundService;
  if (bound === undefined) return null;
  if (resourceService === null) {
    return { code: 403, error: '该操作仅管理员可执行，服务间 token 不可用' };
  }
  if (bound !== resourceService) {
    return { code: 403, error: `token 绑定的是服务「${bound}」，不能操作「${resourceService}」的配置` };
  }
  return null;
}


/**
 * 重启助手客户端——调宿主机上的 ainvr-restart-helper.service（唯一动作
 * 端点 POST /restart/<name>，只监听 127.0.0.1:8199）触发
 * ai-service/recorder 的 systemctl restart。
 *
 * backend 容器本身够不着宿主机 systemd（没挂 docker.sock，也没有 sudo），
 * 这是配置发布后"需要重启才生效"的字段唯一的自动重启路径。srs/backend
 * 自己的配置改动全部是 hot，不走这条路——RESTARTABLE_SERVICES 只收这
 * 两个，见 shared/host-restart-helper/restart_helper.py 的同名允许列表
 * （两边独立写死、不是从一份配置生成，改的时候要两边一起改）。
 */

export type RestartableService = 'ai-service' | 'recorder';

export const RESTARTABLE_SERVICES: readonly RestartableService[] = ['ai-service', 'recorder'];

export function isRestartableService(name: unknown): name is RestartableService {
  return typeof name === 'string' && (RESTARTABLE_SERVICES as readonly string[]).includes(name);
}

export interface RestartHelperConfig {
  baseUrl: string;
  token: string;
}

/** 未配置 RESTART_HELPER_URL/TOKEN 时返回 null——调用方据此把"自动重启"
 *  功能整体禁用（不是报错，是「这个部署没接这条能力」）。 */
export function restartHelperConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RestartHelperConfig | null {
  const baseUrl = (env.RESTART_HELPER_URL || '').trim();
  const token = (env.RESTART_HELPER_TOKEN || '').trim();
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

export interface RestartResult {
  ok: boolean;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** 触发重启；只等 systemctl restart 命令本身被接受执行（几秒内返回），
 *  不等服务完全起来——完全起来的判定由调用方轮询 service-states 完成。 */
export async function triggerRestart(
  config: RestartHelperConfig,
  service: RestartableService,
  fetchImpl: typeof fetch = fetch,
): Promise<RestartResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${config.baseUrl}/restart/${service}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    const body = (await resp.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!resp.ok || !body?.ok) {
      return { ok: false, error: body?.error || `重启助手返回状态码 ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? '重启助手响应超时' : `重启助手不可达: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 最近一次关机序列结果（重启助手内存态）：failed 时已停的服务已被尽量恢复 */
export interface ShutdownStatus {
  state: 'idle' | 'running' | 'failed' | 'poweringOff';
  error: string;
  restored: string[];
  restoreFailed: string[];
}

/** 关机请求是 202 立即返回，失败只能事后查：页面在"正在关机"期间轮询它 */
export async function getShutdownStatus(
  config: RestartHelperConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ShutdownStatus> {
  const resp = await fetchImpl(`${config.baseUrl}/shutdown/status`, {
    headers: { Authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(5000),
  });
  const body = (await resp.json().catch(() => null)) as { ok?: boolean; status?: ShutdownStatus } | null;
  if (!resp.ok || !body?.ok || !body.status) throw new Error(`重启助手返回状态码 ${resp.status}`);
  return body.status;
}

export interface ShutdownResult {
  ok: boolean;
  error?: string;
  step?: number;
}

// 关机序列需要更长超时：停 2 个 systemd 服务 + 5 个 docker 容器 + poweroff，
// 每步都有自己的超时，总和最多约 90s。给 120s 留余量。
const SHUTDOWN_TIMEOUT_MS = 120_000;

/** 触发安全关机序列：录像→AI→SRS→前后端→数据库→poweroff。
 *  注意：最后一步 poweroff 执行后系统会立刻断电，连接会自然断开——此时
 *  前端应该已经显示"正在关机"的提示了。失败时返回错误和完成到第几步。 */
export async function triggerShutdown(
  config: RestartHelperConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ShutdownResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHUTDOWN_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`${config.baseUrl}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    const body = (await resp.json().catch(() => null)) as {
      ok?: boolean; error?: string; step?: number; stepsCompleted?: number;
    } | null;
    if (!resp.ok || !body?.ok) {
      return { ok: false, error: body?.error || `重启助手返回状态码 ${resp.status}`, step: body?.step };
    }
    return { ok: true, step: body.stepsCompleted };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    return {
      ok: false,
      error: timedOut
        ? '关机序列执行超时（设备可能已断电）'
        : `重启助手不可达: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

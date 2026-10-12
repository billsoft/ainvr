/**
 * SRS 配置适配器（第 6 步接入的第一版）
 *
 * 范围（刻意收窄，验收边界写死）：
 * - 只支持 srs/system/settings 文档里的 rtcCandidateIp 字段——这是唯一
 *   有「原地写 + SRS 容器 auto_reload_for_docker 热重载」完整验证证据的
 *   字段（见 srsConfWriter.ts 头部注释，2026-09-04 排查记录）。
 * - 其他 srs.conf 字段（端口、转码、HLS 等）一律在 validate 阶段拒绝，
 *   不给"存了但永远不生效"的假象。后续要支持时必须先验证热重载行为。
 *
 * 写入安全：
 * - 写前把 srs.conf 备份为 .bak（单份滚动备份，够回滚本次误写）
 * - writeCandidateIp 内部自带文件锁 + tmp/rename 原子写 + 值未变不落盘
 *
 * 启动时 reapplyPublishedSrsSettings 按最新已发布版本重新下发：srs.conf 在
 * 升级时会被离线包里的默认配置（自动）覆盖，配置中心才是唯一真值。
 */
import fs from 'node:fs';
import type { ConfigDocument, PgConfigStore } from './pgStore.js';
import type { ServiceConfigAdapter, ApplyResult, ValidateResult } from './adapter.js';
import { writeCandidateIp } from '../services/srsConfWriter.js';

/** 像 IP/主机名的字符集；空串 = 自动（按浏览器访问地址），不接受 `*` 等通配写法 */
const CANDIDATE_IP_RE = /^[a-zA-Z0-9.-]{0,253}$/;

const SUPPORTED_KEYS = ['rtcCandidateIp'];

function confPath(): string {
  return process.env.SRS_CONF_PATH || '/srs-conf/srs.conf';
}

export class SrsConfigAdapter implements ServiceConfigAdapter {
  readonly serviceName = 'srs';

  async validate(docs: ConfigDocument[]): Promise<ValidateResult> {
    const errors: string[] = [];
    for (const doc of docs) {
      if (doc.group !== 'system' || doc.name !== 'settings') {
        errors.push(`流媒体服务配置仅支持 system/settings 文档，忽略 ${doc.group}/${doc.name}`);
        continue;
      }
      for (const key of Object.keys(doc.config ?? {})) {
        if (!SUPPORTED_KEYS.includes(key)) {
          errors.push(
            `流媒体服务配置暂不支持字段「${key}」（当前仅支持：${SUPPORTED_KEYS.join('、')}）` +
            '——未验证热重载行为的字段不允许经配置中心修改',
          );
        }
      }
      const candidate = doc.config?.rtcCandidateIp;
      if (candidate !== undefined) {
        if (typeof candidate !== 'string') {
          errors.push('rtcCandidateIp 必须是字符串（空串=自动）');
        } else if (!CANDIDATE_IP_RE.test(candidate)) {
          errors.push('rtcCandidateIp 只能包含字母、数字、点、短横线');
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async apply(docs: ConfigDocument[], targetVersion: number): Promise<ApplyResult> {
    const settings = docs.find((d) => d.group === 'system' && d.name === 'settings');
    if (!settings) {
      // 该版本没有 SRS 配置文档：无事可做，视为成功（不影响其他服务发布）
      return { ok: true, applyVia: 'hot', restartRequired: false, appliedVersion: targetVersion };
    }
    const validation = await this.validate([settings]);
    if (!validation.ok) {
      return {
        ok: false,
        applyVia: 'rejected',
        restartRequired: false,
        error: validation.errors.join('；'),
      };
    }

    const candidate = (settings.config.rtcCandidateIp ?? '') as string;
    try {
      this.backupConf();
      await writeCandidateIp(candidate);
      return { ok: true, applyVia: 'hot', restartRequired: false, appliedVersion: targetVersion };
    } catch (e) {
      return {
        ok: false,
        applyVia: 'rejected',
        restartRequired: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  async rollback(docs: ConfigDocument[], targetVersion: number): Promise<ApplyResult> {
    // 回滚与 apply 同路：把目标版本的 candidate 值重新写回
    return this.apply(docs, targetVersion);
  }

  /** 写前备份 srs.conf → srs.conf.bak（失败不阻断：备份只是锦上添花，
   *  真正的写入本身是原子的；但备份失败要留日志痕迹） */
  private backupConf(): void {
    try {
      const file = confPath();
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, file + '.bak');
      }
    } catch (e) {
      console.warn('[srs-adapter] srs.conf 备份失败（继续写入）:', e instanceof Error ? e.message : e);
    }
  }
}

/**
 * 启动时把最新已发布版本里的流媒体设置重新写进 srs.conf（值没变不落盘，幂等）。
 * 不新建版本、不写审计；失败只返回 false 并记日志，绝不阻断控制台启动。
 */
export async function reapplyPublishedSrsSettings(
  store: Pick<PgConfigStore, 'getLatestVersion' | 'getVersionSnapshotForService'>,
  adapter: SrsConfigAdapter,
): Promise<boolean> {
  try {
    const latest = await store.getLatestVersion('published');
    if (!latest) return true;
    const docs = await store.getVersionSnapshotForService(latest.version, 'srs');
    const r = await adapter.apply(docs, latest.version);
    if (!r.ok) console.error('[srs-adapter] 启动时重新下发流媒体设置失败:', r.error);
    return r.ok;
  } catch (e) {
    console.error('[srs-adapter] 启动时读取已发布的流媒体设置失败:', e instanceof Error ? e.message : e);
    return false;
  }
}

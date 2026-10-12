/**
 * Backend 自身配置适配器
 *
 * ⚠️ 职责澄清（P2-2 评审 2026-09-15；2026-09-16 评审再收口）：
 * - 配置中心（PG + PgConfigStore）是 backend 配置的唯一权威写入口和唯一真源
 * - JsonStore（settings.json）仅作为 PG 不可用时的遗留兼容层 + 迁移前兜底，
 *   不再是配置源；adminPasswordHash 已迁移至 config_secrets
 * - 真正驱动 aiProxy.ts/recorderProxy.ts/SrsClient 行为的是注入进来的
 *   settingsStore（JsonStore<AppSettings> 运行时缓存）。apply() 对
 *   system/settings 文档做和 PUT /api/settings 同款的 AppSettingsSchema
 *   校验后 setCache()，让 ConfigCenter 发布和旧 Settings 页面殊途同归到
 *   同一个运行时状态。
 * - srsApiHost 是唯一不能只靠 setCache 热生效的字段：SrsClient 启动时
 *   构造一次，host 变化必须显式 setApiHost()，否则运行时仍打旧地址。
 *
 * 历史：本类曾维护私有 runtimeConfig Map 和 config-cache.json 冷启动缓存，
 * 但全仓除测试外没有任何消费方（冷启动实际由 app.ts 从 PG 回灌
 * settingsStore），2026-09-16 评审后已整体删除，避免"存了看似生效实则
 * 无效"的假路径。
 */
import type { ConfigDocument } from './pgStore.js';
import type { ServiceConfigAdapter, ApplyResult, ValidateResult } from './adapter.js';
import type { JsonStore } from './jsonStore.js';
import type { AppSettings } from '../types/channel.js';
import type { SrsClient } from '../services/srsClient.js';
import { AppSettingsSchema } from '../routes/settingsShared.js';

export class BackendConfigAdapter implements ServiceConfigAdapter {
  readonly serviceName = 'backend';

  /** settingsStore 未注入时（比如测试直接 new 这个类）不触达运行时；
   *  srsClient 注入后 srsApiHost 变化会热切换，不注入则该字段需重启生效。 */
  constructor(
    private readonly settingsStore?: JsonStore<AppSettings>,
    private readonly srsClient?: Pick<SrsClient, 'setApiHost'>,
  ) {}

  private findSettingsDoc(docs: ConfigDocument[]): ConfigDocument | undefined {
    return docs.find((d) => d.group === 'system' && d.name === 'settings');
  }

  async apply(docs: ConfigDocument[], targetVersion: number): Promise<ApplyResult> {
    try {
      // system/settings 文档校验通过后写进 settingsStore 缓存，
      // aiProxy/recorderProxy/SrsClient 读到的就是这份。
      // validate() 已经在发布前挡过一轮非法配置，这里 safeParse 失败理论上
      // 不该发生（除非绕过了 publishOrchestrator 直接调 apply，比如测试），
      // 稳妥起见仍按失败处理，不静默吞掉。
      const settingsDoc = this.findSettingsDoc(docs);
      if (settingsDoc && this.settingsStore) {
        const parsed = AppSettingsSchema.safeParse(settingsDoc.config);
        if (!parsed.success) {
          return {
            ok: false,
            applyVia: 'rejected',
            restartRequired: false,
            error: `backend/system/settings 不合法: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          };
        }
        // srsApiHost 热切换：SrsClient 只在启动时构造一次，不在这里显式
        // setApiHost 的话，配置中心发布改 host 后运行时仍打旧地址（与本
        // adapter 声明的 applyVia:'hot' 不符）。只在值真正变化时调用。
        if (this.srsClient && parsed.data.srsApiHost) {
          let prevHost: string | undefined;
          try {
            prevHost = (await this.settingsStore.read()).srsApiHost;
          } catch {
            // 读不到旧值就无法判断是否变化——保守地按"变化"处理一次
            prevHost = undefined;
          }
          if (prevHost !== parsed.data.srsApiHost) {
            this.srsClient.setApiHost(parsed.data.srsApiHost);
          }
        }
        this.settingsStore.setCache(parsed.data);
      }

      return {
        ok: true,
        applyVia: 'hot',
        restartRequired: false,
        appliedVersion: targetVersion,
      };
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
    // 回滚和 apply 逻辑一致：把目标版本的设置写进 settingsStore
    return this.apply(docs, targetVersion);
  }

  async validate(docs: ConfigDocument[]): Promise<ValidateResult> {
    // 2026-09-16：system/settings 文档现在真的会被拿去覆盖运行时状态，
    // 发布前必须校验，不能再无条件放行——否则非法配置会在 apply() 时才
    // 报错，用户已经点了"发布"却看到失败，体验比发布前拦截差很多。
    // 其余 backend 文档（目前没有）仍是自由格式，不强制 schema。
    const settingsDoc = this.findSettingsDoc(docs);
    if (!settingsDoc) return { ok: true, errors: [] };
    const parsed = AppSettingsSchema.safeParse(settingsDoc.config);
    if (parsed.success) return { ok: true, errors: [] };
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
}

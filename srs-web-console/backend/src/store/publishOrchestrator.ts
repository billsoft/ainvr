/**
 * 发布编排器：逐服务下发配置，记录逐服务状态，部分成功不回滚
 *
 * 流程：
 * 1. 从 PG 读目标版本的完整快照
 * 2. 发布前按服务做校验（validate），任一服务不通过 → 整个发布拒绝
 * 3. 逐服务调用 adapter.apply(docs, version)
 * 4. 逐服务写 config_service_states（appliedVersion / status / error）
 * 5. 记审计日志
 * 6. 返回逐服务结果（部分成功）
 *
 * 回滚复用同一流程：目标版本换成旧版本快照
 */
import type { PgConfigStore, ConfigDocument, ConfigVersion, ServiceState } from './pgStore.js';
import type { ServiceConfigAdapter, ApplyResult } from './adapter.js';

export interface PerServiceResult {
  service: string;
  ok: boolean;
  applyVia: 'hot' | 'restart' | 'pull' | 'rejected';
  restartRequired: boolean;
  error?: string;
  appliedVersion?: number;
}

export interface PublishResult {
  version: ConfigVersion;
  /** 整体状态：
   *  - all_ok     ：所有服务都 applied（hot 生效或已回报）
   *  - all_pending：所有服务都等待拉取应用（pull 模式）
   *  - partial    ：部分成功（有 applied 也有 pending，或 mix）
   *  - all_failed ：全部失败
   *
   *  P1-1 修复（2026-09-15）：此前 pull 模式服务的 ok:true 也算 all_ok，
   *  导致"发布成功"与"服务已生效"混淆——用户看到 all_ok 但服务实际还
   *  没拉取、没校验、没应用。现在把 pending 单独计数。 */
  overallStatus: 'all_ok' | 'all_pending' | 'partial' | 'all_failed';
  results: PerServiceResult[];
}

export class PublishOrchestrator {
  private adapters = new Map<string, ServiceConfigAdapter>();

  constructor(
    private readonly store: PgConfigStore,
    adapters: ServiceConfigAdapter[] = [],
  ) {
    for (const a of adapters) {
      this.adapters.set(a.serviceName, a);
    }
  }

  registerAdapter(adapter: ServiceConfigAdapter): void {
    this.adapters.set(adapter.serviceName, adapter);
  }

  getAdapter(service: string): ServiceConfigAdapter | undefined {
    return this.adapters.get(service);
  }

  /**
   * 发布：生成新版本 → 校验 → 逐服务下发 → 写状态 → 记审计
   * @returns 逐服务结果，部分成功不抛错
   */
  async publish(
    changeSummary = '',
    actor = 'admin',
    options?: Parameters<PgConfigStore['publish']>[2],
  ): Promise<PublishResult> {
    // 1. 先生成版本（PG 内部原子版本号）
    const version = await this.store.publish(changeSummary, actor, options);
    options?.signal?.throwIfAborted();

    // 2. 读该版本的完整快照
    const docs = await this.store.getVersionSnapshot(version.version);
    if (!docs) {
      throw new Error(`版本 v${version.version} 快照不存在`);
    }

    // 3. 按服务分组
    const byService = this.groupByService(options ? docs.filter(d => options.services.includes(d.service)) : docs);

    // 4. 发布前校验（任一服务校验失败 → 拒绝整个发布，版本还是生成了但状态是 failed）
    const validationErrors = new Map<string, string[]>();
    for (const [svc, svcDocs] of byService) {
      options?.signal?.throwIfAborted();
      const adapter = this.adapters.get(svc);
      if (!adapter) continue; // 没有适配器的服务不校验（发布时会 rejected）
      const v = await adapter.validate(svcDocs);
      if (!v.ok) {
        validationErrors.set(svc, v.errors);
      }
    }
    if (validationErrors.size > 0) {
      // 校验失败：所有服务状态记 rejected + 错误信息
      const results: PerServiceResult[] = [];
      for (const [svc, errors] of validationErrors) {
        await this.store.updateServiceState({
          serviceName: svc,
          status: 'failed',
          desiredVersion: version.version,
          errorMessage: `校验失败: ${errors.join('; ')}`,
        });
        results.push({
          service: svc,
          ok: false,
          applyVia: 'rejected',
          restartRequired: false,
          error: errors.join('; '),
        });
      }
      // 其余服务也是 rejected（还没下发）
      for (const svc of byService.keys()) {
        if (validationErrors.has(svc)) continue;
        await this.store.updateServiceState({
          serviceName: svc,
          status: 'failed',
          desiredVersion: version.version,
          errorMessage: '前置服务校验失败，未下发',
        });
        results.push({
          service: svc,
          ok: false,
          applyVia: 'rejected',
          restartRequired: false,
          error: '前置服务校验失败，未下发',
        });
      }
      // 审计
      await this.store.addAuditLog({
        actor, action: 'publish-failed', versionAfter: version.version,
        detail: { changeSummary, validationErrors: Object.fromEntries(validationErrors) },
      });
      return { version, overallStatus: 'all_failed', results };
    }

    // 5. 逐服务下发
    options?.signal?.throwIfAborted();
    const results: PerServiceResult[] = [];
    let appliedCount = 0;
    let pendingCount = 0;
    let failCount = 0;

    for (const [svc, svcDocs] of byService) {
      options?.signal?.throwIfAborted();
      const adapter = this.adapters.get(svc);
      let result: ApplyResult;

      if (!adapter) {
        result = {
          ok: false,
          applyVia: 'rejected',
          restartRequired: false,
          error: `未注册该服务的配置适配器`,
        };
      } else {
        try {
          result = await adapter.apply(svcDocs, version.version);
        } catch (e) {
          result = {
            ok: false,
            applyVia: 'rejected',
            restartRequired: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }

      options?.signal?.throwIfAborted();
      // 写服务状态
      // pull 模式：发布只置 desiredVersion + pending，不声称已应用；
      // 服务拉取应用后经 service-states API 自报 applied/appliedVersion 覆盖
      const isPull = result.ok && result.applyVia === 'pull';
      const status: ServiceState['status'] = !result.ok
        ? 'failed'
        : isPull
          ? 'pending'
          : result.restartRequired ? 'partial' : 'applied';
      if (!isPull) await this.store.updateServiceState({
        serviceName: svc,
        appliedVersion: result.ok && !isPull ? version.version : undefined,
        desiredVersion: version.version,
        status,
        restartRequired: result.restartRequired,
        // 成功时显式清空历史错误——updateServiceState 的 ON CONFLICT 只覆盖
        // 传入字段，传 undefined 会保留上一次失败留下的 errorMessage（实测：
        // v9 校验失败的错误文本在 v10 成功发布后仍挂在 backend/srs 状态行上）
        errorMessage: result.ok ? '' : result.error,
        appliedAt: result.ok && !isPull ? new Date() : undefined,
      });

      results.push({
        service: svc,
        ok: result.ok,
        applyVia: result.applyVia,
        restartRequired: result.restartRequired,
        error: result.error,
        appliedVersion: result.ok && !isPull ? version.version : undefined,
      });

      if (!result.ok) failCount++;
      else if (isPull) pendingCount++;
      else appliedCount++;
    }

    // 6. 整体状态（P1-1：区分 applied / pending / failed 三种）
    const total = appliedCount + pendingCount + failCount;
    const overallStatus: PublishResult['overallStatus'] =
      failCount === total ? 'all_failed' :
      appliedCount === total ? 'all_ok' :
      pendingCount === total ? 'all_pending' :
      'partial';

    // The publish audit is already committed atomically with the version.
    // This supplementary delivery result cannot undo an applied configuration.
    await this.store.addAuditLog({
      actor, action: 'publish', versionAfter: version.version,
      detail: {
        changeSummary,
        overallStatus,
        perService: Object.fromEntries(results.map(r => [r.service, {
          ok: r.ok, applyVia: r.applyVia, error: r.error,
        }])),
      },
    }).catch(() => console.error('[config] 配置已提交；应用结果审计写入失败'));

    return { version, overallStatus, results };
  }

  // 2026-09-16 产品化收口：面向用户的"版本历史/手动回滚"UI 已整体下线
  // （ConfigCenter 不再展示版本表格与回滚按钮），HTTP 路由
  // POST /v1/config/versions/:version/rollback 已随之删除——本方法是那条
  // 路由唯一的调用方，删除路由后彻底不可达，一并移除。
  // 不动的部分：pgStore.rollbackToVersion()（数据层，仍有 pgStore.test.ts
  // 独立单测覆盖）、ServiceConfigAdapter.rollback()（接口契约，backend/srs/
  // ai-service/recorder 四个实现仍各自保留，backendAdapter.test.ts 等仍
  // 直接单测它）——两者都不是只为这张被删的 UI 表格存在，牵连面更大，留着
  // 不产生任何可达的运行时风险，删了反而增加改错的面。

  /**
   * 发布前预校验：只校验不发布，返回所有服务的校验结果
   */
  async validatePublish(version?: number): Promise<{
    ok: boolean;
    perService: { service: string; ok: boolean; errors: string[] }[];
  }> {
    let docs: ConfigDocument[];
    if (version != null) {
      const snap = await this.store.getVersionSnapshot(version);
      if (!snap) throw new Error(`版本 v${version} 不存在`);
      docs = snap;
    } else {
      // 校验当前草稿：直接读所有文档
      docs = await this.store.listDocuments();
    }
    const byService = this.groupByService(docs);
    const perService: { service: string; ok: boolean; errors: string[] }[] = [];
    let allOk = true;
    for (const [svc, svcDocs] of byService) {
      const adapter = this.adapters.get(svc);
      if (!adapter) {
        perService.push({ service: svc, ok: false, errors: ['未注册适配器'] });
        allOk = false;
        continue;
      }
      const v = await adapter.validate(svcDocs);
      perService.push({ service: svc, ok: v.ok, errors: v.errors });
      if (!v.ok) allOk = false;
    }
    return { ok: allOk, perService };
  }

  private groupByService(docs: ConfigDocument[]): Map<string, ConfigDocument[]> {
    const map = new Map<string, ConfigDocument[]>();
    for (const doc of docs) {
      if (!map.has(doc.service)) map.set(doc.service, []);
      map.get(doc.service)!.push(doc);
    }
    return map;
  }
}

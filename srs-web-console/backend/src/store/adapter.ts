/**
 * 配置服务适配器接口
 * - 每个服务（backend / srs / ai-service / recorder）一个实现
 * - 发布编排器通过统一接口调用各服务下发配置
 * - 逐服务返回 { ok, applyVia, error }，部分成功不影响其他服务
 */
import type { ConfigDocument } from './pgStore.js';

export interface ApplyResult {
  ok: boolean;
  /** 生效方式：hot=立即生效 / restart=需重启 / pull=服务自行拉取（发布时置 pending，
   *  客户端拉取应用后自报 applied 覆盖） / rejected=拒绝修改 */
  applyVia: 'hot' | 'restart' | 'pull' | 'rejected';
  /** 是否需要重启服务才完全生效 */
  restartRequired: boolean;
  /** 失败原因（ok=false 时） */
  error?: string;
  /** 应用后实际生效的版本号 */
  appliedVersion?: number;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

export interface ServiceConfigAdapter {
  /** 服务名，对应 config_documents.service */
  readonly serviceName: string;

  /**
   * 下发配置到该服务
   * @param docs 该服务在目标版本下的所有配置文档（从快照读取）
   * @param targetVersion 目标版本号
   */
  apply(docs: ConfigDocument[], targetVersion: number): Promise<ApplyResult>;

  /**
   * 回滚配置（和 apply 对称，传入目标回滚版本文档）
   */
  rollback(docs: ConfigDocument[], targetVersion: number): Promise<ApplyResult>;

  /** 发布前校验：非法配置直接拒绝，不进入发布流程 */
  validate(docs: ConfigDocument[]): Promise<ValidateResult>;
}

/**
 * 拉模式适配器：服务自己轮询配置中心（desired_version → 拉快照 → 应用 → 自报状态）。
 *
 * 发布时只置 desiredVersion + status=pending，不声称已应用（applyVia:'pull' 由
 * 编排器翻译成 pending；此前用 Stub 返回 ok:false 会导致发布结果显示 failed，
 * 而服务随后又自报 applied，状态自相矛盾）。已接入：recorder（A1）、ai-service（A2）。
 */
export class PullModeAdapter implements ServiceConfigAdapter {
  constructor(public readonly serviceName: string) {}

  async apply(_docs: ConfigDocument[], _targetVersion: number): Promise<ApplyResult> {
    return { ok: true, applyVia: 'pull', restartRequired: false };
  }

  async rollback(_docs: ConfigDocument[], _targetVersion: number): Promise<ApplyResult> {
    return { ok: true, applyVia: 'pull', restartRequired: false };
  }

  async validate(_docs: ConfigDocument[]): Promise<ValidateResult> {
    // 拉模式服务的深度校验由服务端拉取后自己做（校验失败自报 failed）
    return { ok: true, errors: [] };
  }
}

/**
 * 基础 stub 适配器：未实现真实下发的服务统一返回 rejected
 * 第 5 步 (ai-service / recorder) 和第 6 步 (srs) 再实现真实适配器
 */
export class StubConfigAdapter implements ServiceConfigAdapter {
  constructor(
    public readonly serviceName: string,
    private readonly reason: string = '该服务配置适配器尚未实现，将在后续步骤接入',
  ) {}

  async apply(_docs: ConfigDocument[], _targetVersion: number): Promise<ApplyResult> {
    return {
      ok: false,
      applyVia: 'rejected',
      restartRequired: false,
      error: this.reason,
    };
  }

  async rollback(_docs: ConfigDocument[], _targetVersion: number): Promise<ApplyResult> {
    return {
      ok: false,
      applyVia: 'rejected',
      restartRequired: false,
      error: this.reason,
    };
  }

  async validate(_docs: ConfigDocument[]): Promise<ValidateResult> {
    // 未接入校验的服务：放行，发布时再拒绝
    return { ok: true, errors: [] };
  }
}

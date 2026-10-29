import { randomUUID } from 'node:crypto';
import { invalidateAiKeyCache } from '../routes/aiProxy.js';
import type { PgConfigStore } from '../store/pgStore.js';
import type { PublishResult } from '../store/publishOrchestrator.js';
import { isRestartableService, restartHelperConfigFromEnv, triggerRestart } from './restartHelperClient.js';

export interface ApplyOperation {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'timeout';
  stage: string;
  startedAt: number;
  deadline: number;
  version?: number;
  services: string[];
}

/** One bounded server-owned operation. Closing/reloading the browser cannot
 * cancel a required restart. No document contents or credentials in status. */
export class ConfigApply {
  current: ApplyOperation | null = null;
  private history = new Map<string, ApplyOperation>();
  get(id: string): ApplyOperation | null { return this.history.get(id) ?? null; }
  private executing = false;
  get busy() { return this.executing; }
  constructor(private store: PgConfigStore, private timeoutMs = 480_000,
    private ready: (service: string) => Promise<boolean> = async () => true) {}

  start(services: string[], publish: (signal: AbortSignal) => Promise<PublishResult>, options?: {signal?: AbortSignal;timeoutMs?:number}): ApplyOperation {
    if (this.busy) throw new Error('另一次配置更新正在进行，请稍后重试');
    const timeoutMs=options?.timeoutMs??this.timeoutMs;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>this.timeoutMs)throw new Error('无效的配置应用期限');
    const job: ApplyOperation = { id: randomUUID(), status: 'running', stage: '正在校验并保存配置',
      startedAt: Date.now(), deadline: Date.now() + timeoutMs, services };
    this.current = job;
    this.history.set(job.id, job);
    if (this.history.size > 20) this.history.delete(this.history.keys().next().value!);
    this.executing = true;
    void this.run(job, publish,options?.signal).finally(() => { this.executing = false; });
    return job;
  }

  private async run(job: ApplyOperation, publish: (signal: AbortSignal) => Promise<PublishResult>,externalSignal?:AbortSignal) {
    const controller = new AbortController();
    const abortExternal=()=>{if(job.status==='running'){job.status='timeout';job.stage='操作已结束，正在确认配置状态；请检查服务应用结果';}controller.abort();};
    externalSignal?.addEventListener('abort',abortExternal,{once:true});
    if(externalSignal?.aborted)abortExternal();
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('配置更新超时'));
      if (controller.signal.aborted) { reject(new Error('配置更新超时')); return; }
      controller.signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    });
    const watchdog = setTimeout(() => {
      job.status = 'timeout';
      job.stage = '更新超时，页面已解锁；服务可能仍在应用，请检查服务状态后再试';
      controller.abort();
    }, Math.max(1,job.deadline-Date.now()));
    watchdog.unref?.();
    try {
      controller.signal.throwIfAborted();
      const result = await bounded(publish(controller.signal));
      job.version = result.version.version;
      if (job.status !== 'running') return;
      if (result.results.some(r => !r.ok)) throw new Error('配置应用失败，请检查服务连接和参数后重试');
      const restarted = new Map<string, string>();
      while (Date.now() < job.deadline && job.status === 'running') {
        const states = await bounded(this.store.listServiceStates());
        if (job.status !== 'running') return;
        let complete = true;
        for (const service of job.services) {
          const state = states.find(s => s.serviceName === service);
          if (state?.desiredVersion !== job.version) throw new Error('配置版本已被其他操作更新，请重新加载后确认');
          if (state.status === 'failed') throw new Error(`${service} 应用失败，请检查服务连接、存储和配置`);
          const before = restarted.get(service);
          const fresh = before === undefined || String(state.appliedAt ?? '') !== before;
          if (state.appliedVersion === job.version && state.status === 'applied' && !state.restartRequired && fresh && await bounded(this.ready(service))) continue;
          if (job.status !== 'running') return;
          complete = false;
          job.stage = `${service}：${before !== undefined ? '正在重启并等待恢复' : '正在等待配置生效'}`;
          if (state.appliedVersion === job.version && state.restartRequired && before === undefined) {
            if (!isRestartableService(service)) throw new Error(`${service} 需要人工重启`);
            const helper = restartHelperConfigFromEnv();
            if (!helper) throw new Error('自动重启助手未配置，配置已保存但尚未完全生效');
            restarted.set(service, String(state.appliedAt ?? ''));
            // Mark before triggering: an immediate fresh report must not be overwritten.
            await bounded(this.store.updateServiceState({ serviceName: service, status: 'restarting', errorMessage: '' }));
            controller.signal.throwIfAborted();
            const restart = await bounded(triggerRestart(helper, service));
            controller.signal.throwIfAborted();
            if (!restart.ok) throw new Error(`${service} 自动重启失败，请检查重启助手`);
            await bounded(this.store.addAuditLog({ actor: 'admin', action: 'restart-triggered', service }));
          }
        }
        if (job.status !== 'running') return;
        if (complete) { invalidateAiKeyCache(); job.status = 'succeeded'; job.stage = '配置已保存并生效'; return; }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      job.status = 'timeout';
      job.stage = '更新超时，页面已解锁；服务可能仍在应用，请检查服务状态后再试';
    } catch (e) {
      if (job.status === 'running') {
        job.status = 'failed';
        job.stage = e instanceof Error ? e.message : '更新失败，请检查服务状态';
      }
    } finally { clearTimeout(watchdog);externalSignal?.removeEventListener('abort',abortExternal); }
  }
}

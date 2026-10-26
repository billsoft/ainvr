import { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Channel } from '../types/channel.js';
import { safeChannel } from '../services/ingestPolicy.js';
import { StatusRoutesOptions, SETTINGS_WHITELIST, SettingsUpdateSchema, ImportValidationError, ExportSchema, writeSettingsToPg } from './settingsShared.js';

export function registerSettingsTransferRoutes(fastify: FastifyInstance, opts: StatusRoutesOptions) {
  const { srsClient, settingsStore, channelService, channelStore, passwordCache, aiServiceFallbackBaseUrl } = opts;
  fastify.post('/v1/config/import-legacy', async (req, reply) => {
    if (!opts.pgStore) {
      reply.status(503);
      return { code: 503, error: '配置中心未启用（未配置 CONFIG_PG_*）' };
    }
    const pgStore = opts.pgStore;
    const report: {
      imported: string[];
      skipped: { item: string; reason: string }[];
      errors: string[];
    } = { imported: [], skipped: [], errors: [] };

    // 1. settings：PG 权威，已有即跳过
    try {
      const existing = await pgStore.getDocument('backend', 'system', 'settings');
      if (existing) {
        report.skipped.push({
          item: 'backend/system/settings',
          reason: '参数库中已存在（配置中心一直在维护），不覆盖',
        });
      } else {
        const legacy = await settingsStore.read();
        await writeSettingsToPg(pgStore, legacy, 'legacy-import');
        report.imported.push('backend/system/settings ← settings.json');
      }
    } catch (e) {
      report.errors.push(`settings 导入失败: ${(e as Error).message}`);
    }

    // 2. channels：只读镜像（运行数据仍由通道管理 API 维护）
    try {
      const channels = await channelStore.read();
      await pgStore.upsertDocument(
        {
          service: 'backend',
          group: 'legacy',
          name: 'channels',
          config: { channels: channels.channels.map(safeChannel) } as unknown as Record<string, unknown>,
          description: 'channels.json 一次性导入镜像（只读；运行数据仍由通道管理 API 维护，勿在此编辑）',
        },
        'legacy-import',
      );
      report.imported.push('backend/legacy/channels ← channels.json（只读镜像）');
    } catch (e) {
      report.errors.push(`channels 镜像失败: ${(e as Error).message}`);
    }

    try {
      await pgStore.addAuditLog({ actor: 'admin', action: 'import-legacy', detail: report as never });
    } catch {
      // 审计失败不影响导入结果返回
    }

    reply.send({ code: 0, data: report });
  });

  // ============================================================
  // GET /api/export — 导出全部数据（不含密码）
  // ============================================================
  fastify.get('/export', async (req, reply) => {
    const channelData = await channelStore.read();
    const settings = await settingsStore.read();

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      channels: channelData.channels.map(c => ({ ...safeChannel(c),
        ...(c.upstreamProtocol === 'rtsp' ? { inputEnabled: false } : {}) })),
      settings: Object.fromEntries(
        SETTINGS_WHITELIST.map(k => [k, settings[k]]),
      ),
    };

    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="srs-console-backup-${Date.now()}.json"`)
      .send({ code: 0, data: exportData });
  });

  // ============================================================
  // POST /api/import — 导入数据
  // ============================================================
  const ImportSchema = z.object({
    mode: z.enum(['merge', 'overwrite']).default('merge'),
    data: ExportSchema,
  });

  fastify.post('/import', async (req, reply) => {
    const parse = ImportSchema.safeParse(req.body);
    if (!parse.success) {
      reply.status(400).send({
        code: 400,
        error: '格式错误：' + parse.error.issues[0]?.message,
      });
      return;
    }

    const { mode, data } = parse.data;
    const channels = data.channels as Channel[];
    if(channels.some(c=>c.onvif && c.upstreamProtocol!=='rtsp'))
      return reply.code(400).send({error:'ONVIF 绑定仅用于 RTSP 输入'});
    function validateManagedSources(items:Channel[]) {
      const seen=new Set<string>();
      for(const c of items) if(c.onvif) {
        const b=c.onvif,key=JSON.stringify([b.deviceId,b.service,b.videoSource,b.profileToken]);
        if(seen.has(key))throw new ImportValidationError('同一 ONVIF 设备码流不能重复导入为多个输入');
        seen.add(key);
      }
    }

    // 所有字段先校验，不能修改了通道才发现设置无效。
    const settingsParse = data.settings ? SettingsUpdateSchema.partial().safeParse(data.settings) : null;
    if (settingsParse && !settingsParse.success) {
      return reply.code(400).send({ code: 400,
        error: '导入数据中的 settings 字段不合法：' + settingsParse.error.issues[0]?.message });
    }
    // Backups never carry device credentials. Import must not start a pull
    // from an unvalidated/unencrypted URL; the operator re-enters credentials.
    for (const c of channels) if (c.upstreamProtocol === 'rtsp') {
      if (c.rtspUrl) {
        const u = new URL(c.rtspUrl);
        if (u.protocol !== 'rtsp:' || u.username || u.password)
          return reply.code(400).send({ error: '拉流凭据不能通过普通备份导入，请在通道编辑中设置' });
      }
      c.inputEnabled = false;
      delete c.sourceRef;
      c.inputGeneration = crypto.randomUUID();
    }

    // 校验 streamName 唯一性（overwrite 模式检查文件内部）
    if (mode === 'overwrite') {
      const names = channels.map(c => c.streamName);
      const uniq = new Set(names);
      if (uniq.size !== names.length) {
        reply.status(400).send({ code: 400, error: '导入数据中有重复的 streamName' });
        return;
      }
    }

    // 处理通道
    let channelCount = 0;
    let previous: Channel[] = [];
    try {
      if (mode === 'overwrite') {
        await channelStore.mutate(d => { validateManagedSources(channels); previous = d.channels; d.channels = channels; });
        channelCount = channels.length;
      } else {
        // merge: 按 id 合并；streamName 冲突以导入为准
        await channelStore.mutate(d => {
          previous = d.channels;
          const byId = new Map(d.channels.map(c => [c.id, c]));
          for (const ch of channels) {
            byId.set(ch.id, ch);
          }
          const merged = Array.from(byId.values());

          // 去重校验放在"算出最终合并结果之后"——不管重名是导入数据
          // 内部自己撞车，还是跟库里现有的另一个 id 撞车，只要合并后有
          // 两个不同 id 共享同一个 streamName 就必须拒绝，不落盘。
          // ⚠️ 此前这里算了一个 names 的 Set 却从来没有 .has() 判断过，
          // 形同虚设，是审计出来的真实 bug——不是少写校验，是校验写了
          // 但从未生效。
          const ownerOf = new Map<string, string>(); // streamName -> id
          for (const c of merged) {
            const owner = ownerOf.get(c.streamName);
            if (owner && owner !== c.id) {
              throw new ImportValidationError(
                `streamName 冲突：「${c.streamName}」同时被通道 ${owner} 和 ${c.id} 使用`,
              );
            }
            ownerOf.set(c.streamName, c.id);
          }

          validateManagedSources(merged);
          d.channels = merged;
          channelCount = merged.length;
        });
      }
    } catch (e) {
      if (e instanceof ImportValidationError) {
        reply.status(400).send({ code: 400, error: e.message });
        return;
      }
      throw e;
    }

    try { await channelService.cleanupDiscardedInputSecrets(previous); }
    catch (err) { fastify.log.warn({ err }, '导入已提交，旧拉流凭据清理失败'); }

    // 处理设置（只导入白名单字段，且必须先过一遍跟 PUT /settings 同一套
    // schema——此前这里直接 (s as any)[key] = 原始值，settings 整体是
    // z.record(z.any()) 完全不做类型检查，例如 {"srsApiHost": 123} 会
    // 一路写进去，后面 srsClient.setApiHost(String(123)) 安静地把 SRS
    // 轮询地址改错，PUT /settings 路径本会直接拒绝这种输入）。
    if (settingsParse?.success) {
      await settingsStore.mutate(s => {
        for (const key of SETTINGS_WHITELIST) {
          const value = (settingsParse.data as Record<string, unknown>)[key];
          if (value !== undefined) {
            (s as any)[key] = value;
          }
        }
        // 密码哈希不导入，保持原样
      });

      // SRS API host 变更通知
      if (settingsParse.data.srsApiHost) {
        srsClient.setApiHost(settingsParse.data.srsApiHost);
      }
    }

    reply.send({
      code: 0,
      data: {
        imported: true,
        mode,
        channelCount,
      },
    });
  });

  // ============================================================
  // POST /api/ai-test-connection — 测试 AI 微服务连通性
  // ============================================================
  // 不走 /api/ai/* 那条通用透传代理（aiProxy.ts）——那条是"转发任意请求"，
  // 这里是"用一次专门的探活请求验证一组连接参数"，语义不同、超时也更短。
  // body 可选传 baseUrl/apiKey：向导里"先测后存"场景要测的是用户刚输入、
  // 还没点保存的值，不能只测已持久化的 settings。不传则测当前已保存的。



}

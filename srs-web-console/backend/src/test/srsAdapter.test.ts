/**
 * SrsConfigAdapter 直接单测（2026-09-17 补，此前完全没有针对这个类的
 * 单测——rtcCandidateIp 的双字段归属 bug 排查发现，这个类是唯一真正把
 * candidate 写进 srs.conf 的路径，却只被 config.test.ts 间接覆盖过发布
 * 编排的分支，没人直接测过 validate/apply/rollback 本身）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SrsConfigAdapter, reapplyPublishedSrsSettings } from '../store/srsAdapter.js';
import type { ConfigDocument } from '../store/pgStore.js';

const CONF_WITH_CANDIDATE = `rtc_server {
    candidate       $CANDIDATE;
}
`;

function doc(config: Record<string, unknown>): ConfigDocument {
  return {
    id: 1,
    service: 'srs',
    group: 'system',
    name: 'settings',
    config,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('SrsConfigAdapter', () => {
  let confDir: string;
  let confFile: string;
  let originalConfPath: string | undefined;
  let adapter: SrsConfigAdapter;

  beforeEach(() => {
    confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srsadapter-test-'));
    confFile = path.join(confDir, 'srs.conf');
    fs.writeFileSync(confFile, CONF_WITH_CANDIDATE, 'utf8');
    originalConfPath = process.env.SRS_CONF_PATH;
    process.env.SRS_CONF_PATH = confFile;
    adapter = new SrsConfigAdapter();
  });

  afterEach(() => {
    try { fs.rmSync(confDir, { recursive: true, force: true }); } catch {}
    if (originalConfPath === undefined) delete process.env.SRS_CONF_PATH;
    else process.env.SRS_CONF_PATH = originalConfPath;
  });

  describe('validate', () => {
    it('rtcCandidateIp 合法格式通过', async () => {
      const r = await adapter.validate([doc({ rtcCandidateIp: '192.168.100.183' })]);
      expect(r.ok).toBe(true);
    });

    it('空字符串（自动：按浏览器访问地址）合法', async () => {
      const r = await adapter.validate([doc({ rtcCandidateIp: '' })]);
      expect(r.ok).toBe(true);
    });

    it('带分号/换行的非法值拒绝', async () => {
      const r = await adapter.validate([doc({ rtcCandidateIp: '1.2.3.4;\n}\nvhost evil {' })]);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('rtcCandidateIp');
    });

    it('星号不能经配置中心直接写入（自动模式用空字符串表达）', async () => {
      const r = await adapter.validate([doc({ rtcCandidateIp: '*' })]);
      expect(r.ok).toBe(false);
    });

    it('不支持的字段一律拒绝——不允许经配置中心改未验证热重载行为的字段', async () => {
      const r = await adapter.validate([doc({ listen: '1935' })]);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('listen');
    });
  });

  describe('apply', () => {
    it('把 candidate 值真正写进 srs.conf', async () => {
      const r = await adapter.apply([doc({ rtcCandidateIp: '192.168.100.183' })], 7);
      expect(r.ok).toBe(true);
      expect(r.applyVia).toBe('hot');
      expect(r.restartRequired).toBe(false);
      expect(r.appliedVersion).toBe(7);
      expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       192.168.100.183;');
    });

    it('空字符串写成自动（candidate *），其余自动相关指令原样保留', async () => {
      fs.writeFileSync(confFile, 'rtc_server {\n    candidate       10.0.0.1;\n    use_auto_detect_network_ip off;\n    api_as_candidates on;\n}\n', 'utf8');
      const r = await adapter.apply([doc({ rtcCandidateIp: '' })], 8);
      expect(r.ok).toBe(true);
      const text = fs.readFileSync(confFile, 'utf8');
      expect(text).toContain('candidate       *;');
      expect(text).toContain('use_auto_detect_network_ip off;');
      expect(text).toContain('api_as_candidates on;');
      expect(text).not.toContain('$CANDIDATE');
    });

    it('旧版占位符配置也能切到手动地址再切回自动', async () => {
      await adapter.apply([doc({ rtcCandidateIp: '192.168.1.20' })], 1);
      expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       192.168.1.20;');
      await adapter.apply([doc({ rtcCandidateIp: '' })], 2);
      expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       *;');
    });

    it('写入前把 srs.conf 备份为 .bak', async () => {
      await adapter.apply([doc({ rtcCandidateIp: '192.168.100.183' })], 1);
      expect(fs.existsSync(confFile + '.bak')).toBe(true);
      expect(fs.readFileSync(confFile + '.bak', 'utf8')).toBe(CONF_WITH_CANDIDATE);
    });

    it('conf 文件里没有 candidate 指令行时，如实返回 rejected 而不是假装 hot', async () => {
      fs.writeFileSync(confFile, 'listen 1935;\n', 'utf8');
      const r = await adapter.apply([doc({ rtcCandidateIp: '192.168.100.183' })], 1);
      expect(r.ok).toBe(false);
      expect(r.applyVia).toBe('rejected');
      expect(r.error).toBeTruthy();
    });

    it('该版本没有 srs 文档时视为无事可做，成功返回而不影响其它服务发布', async () => {
      const r = await adapter.apply([], 3);
      expect(r.ok).toBe(true);
      expect(r.applyVia).toBe('hot');
    });

    it('不支持的字段在 apply 阶段也拒绝（validate 被绕过时的兜底）', async () => {
      const r = await adapter.apply([doc({ hls_fragment: '10' })], 1);
      expect(r.ok).toBe(false);
      expect(r.applyVia).toBe('rejected');
    });
  });

  describe('rollback', () => {
    it('与 apply 同路：把目标版本的 candidate 值重新写回', async () => {
      await adapter.apply([doc({ rtcCandidateIp: '192.168.100.183' })], 1);
      const r = await adapter.rollback([doc({ rtcCandidateIp: '10.0.0.5' })], 1);
      expect(r.ok).toBe(true);
      expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       10.0.0.5;');
    });
  });
});

describe('reapplyPublishedSrsSettings（启动时按配置中心重新下发）', () => {
  let confDir: string;
  let confFile: string;
  let original: string | undefined;
  beforeEach(() => {
    confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srsreapply-test-'));
    confFile = path.join(confDir, 'srs.conf');
    // 升级时离线包带来的默认配置是自动
    fs.writeFileSync(confFile, 'rtc_server {\n    candidate       *;\n}\n', 'utf8');
    original = process.env.SRS_CONF_PATH;
    process.env.SRS_CONF_PATH = confFile;
  });
  afterEach(() => {
    try { fs.rmSync(confDir, { recursive: true, force: true }); } catch {}
    if (original === undefined) delete process.env.SRS_CONF_PATH;
    else process.env.SRS_CONF_PATH = original;
  });

  function store(version: number | null, docs: ConfigDocument[] | Error) {
    const calls: unknown[] = [];
    return {
      calls,
      getLatestVersion: async (status?: string) => { calls.push(['latest', status]); return version === null ? null : { version } as never; },
      getVersionSnapshotForService: async (v: number, service: string) => {
        calls.push(['snapshot', v, service]);
        if (docs instanceof Error) throw docs;
        return docs;
      },
    };
  }

  it('把已发布的手动地址写回（升级覆盖了配置文件也不会丢）', async () => {
    const s = store(39, [doc({ rtcCandidateIp: '192.168.100.183' })]);
    expect(await reapplyPublishedSrsSettings(s, new SrsConfigAdapter())).toBe(true);
    expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       192.168.100.183;');
    expect(s.calls).toEqual([['latest', 'published'], ['snapshot', 39, 'srs']]);
  });

  it('没有已发布版本时什么都不改', async () => {
    expect(await reapplyPublishedSrsSettings(store(null, []), new SrsConfigAdapter())).toBe(true);
    expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       *;');
  });

  it('读取失败只返回 false，不抛出、不阻断启动', async () => {
    expect(await reapplyPublishedSrsSettings(store(39, new Error('db down')), new SrsConfigAdapter())).toBe(false);
    expect(fs.readFileSync(confFile, 'utf8')).toContain('candidate       *;');
  });
});

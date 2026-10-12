import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCandidateIp } from '../services/srsConfWriter.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'srsconf-test-'));
}

// 贴近真实 srs.conf 结构：candidate 指令前有两行解释性注释，其中一行
// 字面包含 "candidate" 这个词——这正是真实事故复现的关键：早期实现的
// 正则/sed 都不锚定行首，会把这类注释行也当成目标行整行替换掉。
const CONF_TEMPLATE = (candidateValue: string) => `listen              1935;

rtc_server {
    enabled         on;
    listen          8000;
    # candidate 由环境变量注入，留空时自动探测（局域网环境通常不可用）
    # 运行时可由 console 设置页原地改写此行，触发 SRS 热重载
    candidate       ${candidateValue};
}

vhost __defaultVhost__ {
    rtc { enabled on; }
}
`;

describe('srsConfWriter.writeCandidateIp', () => {
  let tmpDir: string;
  let confFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    confFile = path.join(tmpDir, 'srs.conf');
    originalEnv = process.env.SRS_CONF_PATH;
    process.env.SRS_CONF_PATH = confFile;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (originalEnv === undefined) delete process.env.SRS_CONF_PATH;
    else process.env.SRS_CONF_PATH = originalEnv;
  });

  it('只替换真正的指令行，不触碰包含同一单词的注释行（回归事故复现）', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('$CANDIDATE'));

    await writeCandidateIp('192.168.100.183');

    const content = fs.readFileSync(confFile, 'utf8');
    // 注释行必须原样保留，一个字都不能变
    expect(content).toContain('# candidate 由环境变量注入，留空时自动探测（局域网环境通常不可用）');
    expect(content).toContain('# 运行时可由 console 设置页原地改写此行，触发 SRS 热重载');
    // 真正的指令行必须被替换成新值
    expect(content).toContain('    candidate       192.168.100.183;');
    expect(content).not.toContain('$CANDIDATE');
  });

  it('保留指令行原有的缩进', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('$CANDIDATE'));
    await writeCandidateIp('10.0.0.5');
    const content = fs.readFileSync(confFile, 'utf8');
    expect(content).toMatch(/^ {4}candidate {7}10\.0\.0\.5;$/m);
  });

  it('空字符串写成自动（candidate *，按浏览器访问地址），不再回到环境变量占位符', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('192.168.100.183'));
    await writeCandidateIp('');
    const content = fs.readFileSync(confFile, 'utf8');
    expect(content).toContain('candidate       *;');
    expect(content).not.toContain('$CANDIDATE');
  });

  it('值未变化时不写盘（避免无意义触发 SRS reload）', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('192.168.100.183'));
    const before = fs.statSync(confFile).mtimeMs;

    await writeCandidateIp('192.168.100.183'); // 跟当前值一样

    const after = fs.statSync(confFile).mtimeMs;
    expect(after).toBe(before);
  });

  it('文件里找不到 candidate 指令行时抛异常，不静默失败', async () => {
    fs.writeFileSync(confFile, 'listen 1935;\n');
    await expect(writeCandidateIp('1.2.3.4')).rejects.toThrow(/candidate/);
  });

  it('写入是原子的：不留下 .tmp 残留文件', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('$CANDIDATE'));
    await writeCandidateIp('192.168.100.183');
    expect(fs.existsSync(confFile + '.tmp')).toBe(false);
  });

  it('回归：两次并发写入不会互相踩踏对方的临时文件（此前无锁保护）', async () => {
    fs.writeFileSync(confFile, CONF_TEMPLATE('$CANDIDATE'));
    // 两个"标签页"几乎同时提交不同的值——不管最终谁赢，文件必须是二者之一
    // 的完整有效结果，不能是被截断/损坏的中间状态，也不能抛错。
    await Promise.all([
      writeCandidateIp('192.168.100.183'),
      writeCandidateIp('10.0.0.5'),
    ]);
    const content = fs.readFileSync(confFile, 'utf8');
    const matched = content.match(/candidate\s+([^\s;]+);/);
    expect(['192.168.100.183', '10.0.0.5']).toContain(matched?.[1]);
    expect(fs.existsSync(confFile + '.tmp')).toBe(false);
  });
});

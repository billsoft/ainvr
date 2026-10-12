import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrandingLoader, DEFAULT_BRANDING, parseBrandingText } from '../services/branding.js';
import { buildApp } from '../app.js';
import { buildTestApp } from './buildTestApp.js';
import { LicenseClient } from '../license/licenseClient.js';
import { LicenseGate } from '../license/licenseGate.js';

// OEM 品牌信息：部署目录里的 branding.yaml（"字段: 值"），改完刷新浏览器即生效，
// 不重新编译、不重启。文件不存在用内置默认品牌；文件存在则以文件为准。

describe('parseBrandingText', () => {
  it('读"字段: 值"，支持注释、引号、行尾注释', () => {
    const { branding, warnings } = parseBrandingText([
      '# 顶部注释',
      'product_name: 某某智能视频平台   # 行尾注释',
      'subtitle: "安防管理 # 不是注释"',
      "short_name: '某某'",
      'version_label: V3.1',
      'tagline: 接入 · 监看',
      'copyright_holder: 某某科技有限公司',
      'copyright_start_year: 2021',
      'contact_name: 张三',
      'contact_phone: "400-800-1234"',
    ].join('\n'));
    expect(warnings).toEqual([]);
    expect(branding).toEqual({
      productName: '某某智能视频平台', subtitle: '安防管理 # 不是注释', shortName: '某某', versionLabel: 'V3.1',
      tagline: '接入 · 监看', copyrightHolder: '某某科技有限公司', copyrightStartYear: 2021,
      contactName: '张三', contactPhone: '400-800-1234',
    });
  });

  it('文件存在即以文件为准：没写或留空的字段为空（界面不显示），绝不回落成内置品牌', () => {
    const { branding } = parseBrandingText('product_name: 某某平台\ncontact_phone:\n');
    expect(branding.productName).toBe('某某平台');
    expect(branding.contactPhone).toBe('');
    expect(branding.contactName).toBe('');           // 没写：同样为空，不显示我们的联系人
    expect(branding.copyrightHolder).toBe('');
    expect(branding.copyrightStartYear).toBeNull();
  });

  it('写错的内容给出警告但不整份作废', () => {
    const { branding, warnings } = parseBrandingText(
      'product_name: 某某平台\ncopyright_start_year: 明年\nlogo_url: x\n这一行没有冒号\n');
    expect(branding.productName).toBe('某某平台');
    expect(branding.copyrightStartYear).toBeNull();
    expect(warnings.join('\n')).toMatch(/copyright_start_year/);
    expect(warnings.join('\n')).toMatch(/logo_url/);
    expect(warnings.join('\n')).toMatch(/第 4 行/);
  });
});

describe('出厂模板 deploy/branding/branding.yaml', () => {
  it('能无警告解析，且与内置默认品牌完全一致（两处不会各改各的）', () => {
    const file = fileURLToPath(new URL('../../../deploy/branding/branding.yaml', import.meta.url));
    const { branding, warnings } = parseBrandingText(fs.readFileSync(file, 'utf-8'));
    expect(warnings).toEqual([]);
    expect(branding).toEqual(DEFAULT_BRANDING);
  });
});

describe('createBrandingLoader', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('文件不存在 → 内置默认品牌', () => {
    const r = createBrandingLoader(path.join(dir, 'branding.yaml'))();
    expect(r.source).toBe('default');
    expect(r.branding).toEqual(DEFAULT_BRANDING);
  });

  it('改文件后下一次读取就是新内容（按修改时间重读，不用重启）', () => {
    const file = path.join(dir, 'branding.yaml');
    fs.writeFileSync(file, 'product_name: 甲\n');
    const load = createBrandingLoader(file);
    expect(load().branding.productName).toBe('甲');
    fs.writeFileSync(file, 'product_name: 乙\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(load()).toMatchObject({ source: 'file', branding: { productName: '乙' } });
  });
});

describe('GET /api/branding', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branding-api-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('返回配置文件里的品牌', async () => {
    const file = path.join(dir, 'branding.yaml');
    fs.writeFileSync(file, 'product_name: 某某平台\nsubtitle: 副标题\n');
    const app = await buildTestApp({ dataDir: dir, brandingFile: file });
    const res = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ productName: '某某平台', subtitle: '副标题', source: 'file' });
    await app.close();
  });

  it('未授权时也能取（登录页、授权页要显示品牌）', async () => {
    const client = new LicenseClient({
      transport: { request: async () => { throw new Error('license service offline'); } },
    });
    const app = await buildApp({
      dataDir: dir, brandingFile: path.join(dir, 'none.yaml'),
      licenseClient: client, licenseGate: new LicenseGate(client, { enabled: true }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.productName).toBe(DEFAULT_BRANDING.productName);
    await app.close();
  });
});

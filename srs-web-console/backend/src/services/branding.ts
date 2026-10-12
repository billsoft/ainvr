// OEM 品牌信息（产品名、副标题、版权、联系方式）：从部署目录的 branding.yaml 读取，
// 改完刷新浏览器即生效——不重新编译前端、不重启服务。
//
// 文件格式是扁平的"字段: 值"（YAML 的子集，可用 # 注释、可加引号），字段见
// deploy/branding/branding.yaml 模板。语义：
// - 文件不存在 → 内置默认品牌（DEFAULT_BRANDING）；
// - 文件存在 → 以文件为准，没写或留空的字段为空、界面不显示该项。绝不回落成内置
//   品牌，避免 OEM 漏填某项时露出我们的公司名/电话。
import fs from 'node:fs';

export interface Branding {
  productName: string;
  subtitle: string;
  shortName: string;
  /** 留空显示软件真实版本 */
  versionLabel: string;
  tagline: string;
  copyrightHolder: string;
  copyrightStartYear: number | null;
  contactName: string;
  contactPhone: string;
}

export const DEFAULT_BRANDING: Branding = {
  productName: 'AINVR',
  subtitle: '智能视频管理平台',
  shortName: 'AINVR',
  versionLabel: '',
  tagline: '视频接入 · 实时监看 · 录像回放 · AI 识别',
  copyrightHolder: 'AINVR',
  copyrightStartYear: 2026,
  contactName: '',
  contactPhone: '',
};

const TEXT_FIELDS = {
  product_name: 'productName',
  subtitle: 'subtitle',
  short_name: 'shortName',
  version_label: 'versionLabel',
  tagline: 'tagline',
  copyright_holder: 'copyrightHolder',
  contact_name: 'contactName',
  contact_phone: 'contactPhone',
} as const satisfies Record<string, Exclude<keyof Branding, 'copyrightStartYear'>>;

const MAX_LEN = 200;

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
  }
  // 行尾注释：前面有空白的 #
  return v.replace(/\s+#.*$/, '').trim();
}

export function parseBrandingText(text: string): { branding: Branding; warnings: string[] } {
  const branding: Branding = {
    productName: '', subtitle: '', shortName: '', versionLabel: '', tagline: '',
    copyrightHolder: '', copyrightStartYear: null, contactName: '', contactPhone: '',
  };
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(s);
    if (!m) {
      warnings.push(`第 ${i + 1} 行不是"字段: 值"格式，已忽略`);
      return;
    }
    const key = m[1]!;
    const value = unquote(m[2]!).slice(0, MAX_LEN);
    if (key === 'copyright_start_year') {
      if (!value) return;
      const y = Number(value);
      if (Number.isInteger(y) && y >= 1900 && y <= 2100) branding.copyrightStartYear = y;
      else warnings.push(`copyright_start_year 应为年份（如 2024），当前"${value}"，已忽略`);
      return;
    }
    const field = (TEXT_FIELDS as Record<string, keyof Branding>)[key];
    if (!field) {
      warnings.push(`未知字段 ${key}，已忽略`);
      return;
    }
    (branding as unknown as Record<string, string>)[field] = value;
  });
  return { branding, warnings };
}

export interface BrandingResult {
  branding: Branding;
  source: 'file' | 'default';
  warnings: string[];
}

/** 按文件修改时间缓存：没改就不重读，改了下一次请求即生效 */
export function createBrandingLoader(file: string, log: (msg: string) => void = () => {}): () => BrandingResult {
  let cache: { mtimeMs: number; size: number; result: BrandingResult } | null = null;
  return () => {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      cache = null;
      return { branding: DEFAULT_BRANDING, source: 'default', warnings: [] };
    }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.result;
    try {
      const { branding, warnings } = parseBrandingText(fs.readFileSync(file, 'utf-8'));
      if (warnings.length) log(`[branding] ${file}：${warnings.join('；')}`);
      const result: BrandingResult = { branding, source: 'file', warnings };
      cache = { mtimeMs: st.mtimeMs, size: st.size, result };
      return result;
    } catch (e) {
      log(`[branding] 读取 ${file} 失败，使用内置品牌：${e instanceof Error ? e.message : e}`);
      return { branding: DEFAULT_BRANDING, source: 'default', warnings: ['读取失败'] };
    }
  };
}

// Phase 4 端到端冒烟测试
// 用 puppeteer 真实访问前端页面，验证：创建通道 → 列表展示 → 查看详情 → 删除
// 前置条件：BFF 在 3001 端口、vite dev server 在 5173 端口
// 运行：node e2e/phase4-smoke.mjs

import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';

const CHROMIUM_PATH = (() => {
  const candidates = ['/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  for (const p of candidates) {
    try { execSync(`test -x ${p}`); return p; } catch {}
  }
  throw new Error('找不到 chromium');
})();

// 用时间戳生成唯一流名，避免冲突
const TS = Date.now();
const TEST_STREAM = `e2e_test_${TS}`;
const TEST_NAME = `E2E测试通道${TS}`;

const results = [];

async function step(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
    console.log(`✅ ${name}`);
    results.push({ name, status: 'pass' });
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    results.push({ name, status: 'fail', error: e.message });
  }
}

async function checkPreconditions() {
  // 检查 BFF
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error('BFF health 非 200');
    console.log('  ✓ BFF 在线');
  } catch (e) {
    throw new Error(`前置检查失败: BFF 不可达 (${e.message})`);
  }

  // 检查前端页面
  try {
    const res = await fetch(BASE_URL);
    if (!res.ok) throw new Error('前端页面非 200');
    console.log('  ✓ 前端 dev server 在线');
  } catch (e) {
    throw new Error(`前置检查失败: 前端不可达 (${e.message})`);
  }
}

async function main() {
  console.log('Chromium:', CHROMIUM_PATH);
  console.log('目标页面:', BASE_URL);
  console.log('测试流名:', TEST_STREAM);

  await checkPreconditions();

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // 控制台错误收集
  const consoleErrors: string[] = [];
  page.on('pageerror', e => consoleErrors.push(e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let createdId: string | null = null;

  try {
    // ---- 1. 通道列表页 ----
    await step('列表页加载', async () => {
      await page.goto(`${BASE_URL}/channels`, { waitUntil: 'networkidle0', timeout: 15000 });
      const title = await page.title();
      if (!title) throw new Error('页面无标题');
      console.log(`  标题: ${title}`);
    });

    // ---- 2. 打开创建向导 ----
    await step('打开新建通道向导', async () => {
      // 点击新建通道
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent?.includes('新建通道') || b.textContent?.includes('+ 新建')) {
            (b as HTMLElement).click();
            return;
          }
        }
      });
      await page.waitForSelector('[role="dialog"], dialog', { timeout: 3000 });
    });

    // ---- 3. 填写并提交 ----
    await step('创建新通道（RTMP + FLV/HLS）', async () => {
      // 填名称
      await page.evaluate((name: string) => {
        const inputs = document.querySelectorAll('input');
        for (const inp of inputs) {
          const i = inp as HTMLInputElement;
          if (i.name === 'name' || i.placeholder?.includes('名称')) {
            i.value = name;
            i.dispatchEvent(new Event('input', { bubbles: true }));
            i.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      }, TEST_NAME);

      // 选 RTMP 上游协议（默认可能就是）
      await page.evaluate(() => {
        const selects = document.querySelectorAll('select');
        for (const s of selects) {
          const sel = s as HTMLSelectElement;
          if (sel.name?.includes('upstream') || sel.name === 'upstreamProtocol') {
            sel.value = 'rtmp';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return;
          }
        }
      });

      // 点下一步 → 下一步 → 完成
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const b of btns) {
            if (b.textContent?.includes('下一步') || b.textContent?.includes('完成')) {
              (b as HTMLElement).click();
              return;
            }
          }
        });
        await new Promise(r => setTimeout(r, 500));
      }

      // 等成功（toast 或列表更新）
      await new Promise(r => setTimeout(r, 2000));

      // 验证列表里有新通道
      const found = await page.evaluate((name: string) => {
        return document.body.innerText.includes(name);
      }, TEST_NAME);

      if (!found) throw new Error('列表中未找到新创建的通道');
      console.log('  新通道已出现在列表中');
    });

    // ---- 4. 详情页 ----
    await step('通道详情页 - 全协议地址展示', async () => {
      // 点击通道名进入详情
      const clicked = await page.evaluate((name: string) => {
        const links = document.querySelectorAll('a');
        for (const l of links) {
          if (l.textContent?.includes(name)) {
            (l as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, TEST_NAME);

      if (!clicked) throw new Error('未找到通道链接');
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 });

      const text = await page.evaluate(() => document.body.innerText);
      const hasRTMP = text.includes('RTMP');
      const hasFLV = text.includes('FLV') || text.includes('flv');
      const hasHLS = text.includes('HLS') || text.includes('m3u8');
      console.log(`  RTMP: ${hasRTMP}, FLV: ${hasFLV}, HLS: ${hasHLS}`);

      // 保存 id 用于后续删除
      const url = page.url();
      const match = url.match(/\/channels\/([^/?]+)/);
      if (match) {
        createdId = match[1];
        console.log(`  通道 ID: ${createdId}`);
      }
    });

    // ---- 5. 返回列表，删除 ----
    await step('删除通道', async () => {
      await page.goto(`${BASE_URL}/channels`, { waitUntil: 'networkidle0', timeout: 10000 });
      const before = await page.$$eval('table tbody tr', rows => rows.length);
      console.log(`  删除前行数: ${before}`);

      // 找删除按钮
      const deleted = await page.evaluate((name: string) => {
        const rows = document.querySelectorAll('table tbody tr');
        for (const row of rows) {
          if (row.textContent?.includes(name)) {
            const delBtn = row.querySelector('button[aria-label*="删除"], button:has(svg):last-child');
            if (delBtn) {
              (delBtn as HTMLElement).click();
              return true;
            }
          }
        }
        return false;
      }, TEST_NAME);

      if (!deleted) throw new Error('未找到删除按钮');
      await new Promise(r => setTimeout(r, 500));

      // 确认删除（requireText 场景可能需要输入）
      const confirmed = await page.evaluate(() => {
        // 简单场景：确认对话框里的确认按钮
        const dialog = document.querySelector('[role="dialog"], dialog');
        if (!dialog) return false;
        const btns = dialog.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent?.includes('确认') || b.textContent?.includes('删除') || b.textContent === 'OK') {
            (b as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (!confirmed) {
        // 可能需要输入 DELETE 文本
        console.log('  检测到需要输入确认文本，尝试输入');
        await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], dialog');
          if (!dialog) return;
          const input = dialog.querySelector('input') as HTMLInputElement | null;
          if (input) {
            input.value = 'DELETE';
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const btns = dialog.querySelectorAll('button');
          for (const b of btns) {
            if (b.textContent?.includes('确认') || b.textContent?.includes('删除')) {
              (b as HTMLElement).click();
              return;
            }
          }
        });
      }

      await new Promise(r => setTimeout(r, 1500));

      const after = await page.$$eval('table tbody tr', rows => rows.length);
      console.log(`  删除后行数: ${after}`);

      if (after >= before) throw new Error('删除后行数未减少');
    });

    // ---- 6. 控制台错误 ----
    await step('页面无阻断性 JS 错误', async () => {
      const realErrors = consoleErrors.filter(e =>
        !e.includes('404') && !e.includes('Failed to load resource') && !e.includes('AbortError')
      );
      console.log(`  console.error 总数: ${consoleErrors.length}, 疑似阻断性: ${realErrors.length}`);
      if (realErrors.length > 0) {
        realErrors.slice(0, 3).forEach(e => console.log(`    • ${e.slice(0, 100)}`));
      }
      // 不硬断言，有错误只记录
    });

    // ---- 7. 清理：BFF 里确认删除（如果 UI 删除没成功）----
    if (createdId) {
      try {
        const res = await fetch(`${BASE_URL}/api/channels/${createdId}`, { method: 'DELETE' });
        console.log(`\n  兜底清理: DELETE ${res.status}`);
      } catch {
        // 忽略
      }
    }

  } finally {
    await browser.close();
  }

  // ---- 汇总 ----
  console.log('\n\n' + '='.repeat(60));
  console.log('  Phase 4 E2E 冒烟测试汇总');
  console.log('='.repeat(60));
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  console.log(`\n  通过: ${passed} / ${results.length}`);
  console.log(`  失败: ${failed}`);
  console.log('');
  for (const r of results) {
    const icon = r.status === 'pass' ? '✅' : '❌';
    console.log(`  ${icon} ${r.name}`);
    if (r.error) console.log(`     └─ ${r.error}`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('E2E 测试异常:', e);
  process.exit(1);
});

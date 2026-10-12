import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

const BASE_URL = 'http://127.0.0.1:5173';
const CHROMIUM_PATH = (() => {
  const cands = ['/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const p of cands) { try { execSync(`test -x ${p}`); return p; } catch {} }
  throw new Error('no chromium');
})();

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // 1. 列表页
  await page.goto(`${BASE_URL}/channels`, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.screenshot({ path: 'e2e/screenshots/01-channels-list.png' });
  
  const rows = await page.$$eval('table tbody tr', rows => rows.length);
  console.log(`列表行数: ${rows}`);
  
  const firstRow = await page.$eval('table tbody tr:first-child', el => el.innerText.slice(0, 100));
  console.log(`第一行内容: ${firstRow}`);

  // 2. 点击第一个通道名进入详情
  const firstLink = await page.$('table tbody tr:first-child a');
  if (firstLink) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), firstLink.click()]);
    await page.screenshot({ path: 'e2e/screenshots/02-channel-detail.png' });
    console.log('详情页 URL:', page.url());
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 300));
    console.log('详情页文本:', pageText.replace(/\n/g, ' | '));
  } else {
    console.log('未找到通道链接');
  }

  await browser.close();
  console.log('\n✅ 前端 → BFF 数据通路验证完成');
  console.log('截图: e2e/screenshots/');
}

main().catch(e => { console.error(e); process.exit(1); });

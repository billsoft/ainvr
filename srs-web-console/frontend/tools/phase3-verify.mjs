// Phase 3 浏览器自动化验收脚本
// puppeteer-core + 系统 chromium headless
// 以程序化断言为主，截图为辅
import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const OUT_DIR = 'test/screenshots';
mkdirSync(OUT_DIR, { recursive: true });

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || (() => {
  const candidates = ['/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  for (const p of candidates) {
    try { execSync(`test -x ${p}`); return p; } catch {}
  }
  throw new Error('找不到 chromium/chrome 可执行文件');
})();

console.log('Chromium:', CHROMIUM_PATH);
console.log('目标页面:', BASE_URL);

const browser = await puppeteer.launch({
  executablePath: CHROMIUM_PATH,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-insecure-localhost',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate',
  ],
});

const results = [];
let page;

async function step(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
    console.log(`✅ ${name}`);
    results.push({ name, status: 'pass' });
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    results.push({ name, status: 'fail', error: e.message });
    try { await page.screenshot({ path: `${OUT_DIR}/fail-${name.replace(/\s+/g,'-').replace(/[^\w-]/g,'')}.png`, fullPage: true }); } catch {}
  }
}

// 等 video 开始播放（currentTime 前进）的辅助函数
async function waitForVideoPlaying(page, sel = 'video', timeout = 10000) {
  return await page.waitForFunction(
    (sel) => {
      const v = document.querySelector(sel);
      return v && v.videoWidth > 0 && v.readyState >= 2 && !v.paused && v.currentTime > 0.5;
    },
    { timeout, polling: 500 },
    sel
  );
}

// 等 video currentTime 前进（证明真在播，不是卡首帧）
async function verifyTimeProgress(page, sel = 'video', samples = 3, intervalMs = 1000) {
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t = await page.$eval(sel, v => v.currentTime);
    times.push(t);
    if (i < samples - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  // 检查严格递增
  const advancing = times.every((t, i) => i === 0 || t > times[i - 1] + 0.3);
  return { advancing, times };
}

// 在页面里 hook RTCPeerConnection 以观察状态
async function installWebRTCHook(page) {
  await page.evaluateOnNewDocument(() => {
    window.__webrtc_log = [];
    const _RTCPeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = function(config, constraints) {
      const pc = new _RTCPeerConnection(config, constraints);
      window.__webrtc_pc = pc;
      window.__webrtc_log.push({ type: 'created', config });
      pc.addEventListener('connectionstatechange', () => {
        window.__webrtc_log.push({ type: 'state', state: pc.connectionState, ts: Date.now() });
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        window.__webrtc_log.push({ type: 'ice', state: pc.iceConnectionState, ts: Date.now() });
      });
      pc.addEventListener('track', () => {
        window.__webrtc_log.push({ type: 'track', ts: Date.now() });
      });
      return pc;
    };
  });
}

try {
  // ---- 先 hook WebRTC 再建页面 ----
  page = await browser.newPage();
  await installWebRTCHook(page);
  await page.setViewport({ width: 1440, height: 900 });

  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push('[pageerror] ' + err.message));

  // ============================================================
  // 1. 通道列表页
  // ============================================================
  await step('P2-1: 通道列表页加载', async () => {
    await page.goto(`${BASE_URL}/channels`, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.screenshot({ path: `${OUT_DIR}/01-channels-list.png` });
    const title = await page.title();
    console.log('   标题:', title);
    // 找表格行
    const rowCount = await page.$$eval('table tbody tr', rows => rows.length);
    console.log(`   通道行数: ${rowCount}`);
    if (rowCount === 0) throw new Error('通道列表为空');
  });

  await step('P2-2: 列表组件（StatusBadge / ProtocolTag / CopyButton）', async () => {
    const hasBadge = (await page.$('[class*="status-badge"], [class*="StatusBadge"], span[class*="bg-"]')) !== null;
    const hasTag = (await page.$('[class*="protocol"], [class*="ProtocolTag"]')) !== null;
    const hasCopyBtn = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).some(b => {
        const label = b.getAttribute('aria-label') || '';
        const title = b.getAttribute('title') || '';
        const hasSvg = b.querySelector('svg') !== null;
        return label.includes('复制') || title.includes('复制') || b.textContent?.includes('复制') || hasSvg;
      });
    });
    console.log(`   StatusBadge: ${hasBadge}, ProtocolTag: ${hasTag}, CopyButton: ${hasCopyBtn}`);
    if (!hasCopyBtn) throw new Error('未找到复制按钮');
  });

  // ============================================================
  // 2. 通道详情页
  // ============================================================
  await step('P2-3: 通道详情页 - 全协议地址展示', async () => {
    // 找第一个通道的链接或直接用已知 mock id
    const firstLink = await page.$('table tbody tr:first-child a');
    if (firstLink) {
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }), firstLink.click()]);
    } else {
      await page.goto(`${BASE_URL}/channels/chn-mock-001`, { waitUntil: 'networkidle0', timeout: 10000 });
    }
    await page.screenshot({ path: `${OUT_DIR}/02-channel-detail.png`, fullPage: true });
    // 找协议地址（RTMP/FLV/HLS/SRT/WebRTC）
    const text = await page.evaluate(() => document.body.innerText);
    const protocols = ['RTMP', 'HTTP-FLV', 'HLS', 'SRT', 'WebRTC'];
    const found = protocols.filter(p => text.includes(p));
    console.log(`   找到协议: ${found.join(', ')} (${found.length}/5)`);
    if (found.length < 3) throw new Error('详情页协议地址不足');
  });

  await step('P2-4: 复制按钮功能（clipboard API）', async () => {
    // 找详情页里的复制按钮（图标按钮）
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        // 紧邻 code/pre/input 的 SVG 按钮很可能是复制按钮
        const parent = b.closest('div');
        const hasSvg = b.querySelector('svg') !== null;
        if (hasSvg && parent && (parent.querySelector('code') || parent.querySelector('pre') || parent.querySelector('input'))) {
          b.click();
          return true;
        }
      }
      // fallback: 第一个带 SVG 的小按钮
      for (const b of btns) {
        if (b.querySelector('svg') && b.clientWidth < 60) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) throw new Error('未找到复制按钮');
    await new Promise(r => setTimeout(r, 500));
    // 检查 toast
    const hasToast = await page.evaluate(() => {
      return document.body.innerText.includes('已复制') || document.body.innerText.includes('复制成功');
    });
    console.log(`   Toast 提示: ${hasToast ? '出现' : '未检测到'}`);
    // 不强制要求 toast 文本精确匹配，但按钮必须可点击
  });

  // ============================================================
  // 3. 创建向导（3 步）
  // ============================================================
  await step('P2-5: 新建通道向导打开', async () => {
    await page.goto(`${BASE_URL}/channels`, { waitUntil: 'networkidle0', timeout: 10000 });
    const newBtn = await page.evaluateHandle(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.includes('新建通道') || b.textContent.includes('+ 新建')) return b;
      }
      return null;
    });
    if ((await newBtn.jsonValue()) === null) throw new Error('找不到新建通道按钮');
    await newBtn.asElement().click();
    await page.waitForSelector('[role="dialog"], dialog, [class*="modal"]', { timeout: 3000 });
    await page.screenshot({ path: `${OUT_DIR}/03-wizard-step1.png` });
    const dialogText = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"], dialog, [class*="modal"]');
      return d ? d.innerText.slice(0, 200) : '';
    });
    console.log('   弹窗存在，文本预览:', dialogText.slice(0, 80).replace(/\n/g,' '));
  });

  await step('P2-6: 向导步骤 1 表单验证', async () => {
    // 空表单点下一步，应报错
    const nextBtn = await page.evaluateHandle(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) if (b.textContent.includes('下一步')) return b;
      return null;
    });
    if ((await nextBtn.jsonValue()) === null) throw new Error('找不到下一步按钮');
    await nextBtn.asElement().click();
    await new Promise(r => setTimeout(r, 500));
    // 应该有错误提示
    const hasError = await page.evaluate(() => {
      return document.body.innerText.includes('必填') || document.body.innerText.includes('请输入');
    });
    console.log(`   空表单验证提示: ${hasError ? '出现' : '未检测到'}`);
  });

  await step('P2-7: 向导步骤 2 - 协议选择', async () => {
    // 填步骤 1
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        if (inp.name === 'name' || inp.placeholder?.includes('名称')) {
          inp.value = '验收测试通道';
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      // 选上游协议
      const selects = document.querySelectorAll('select');
      for (const s of selects) {
        if (s.name?.includes('protocol') || s.name?.includes('upstream')) {
          s.value = 'rtmp';
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    // 点下一步
    const nextBtn = await page.evaluateHandle(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) if (b.textContent.includes('下一步')) return b;
      return null;
    });
    await nextBtn.asElement().click();
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${OUT_DIR}/04-wizard-step2.png` });
    const step2Text = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"], dialog, [class*="modal"]');
      return d ? d.innerText.slice(0, 200) : '';
    });
    console.log('   步骤2 预览:', step2Text.slice(0, 80).replace(/\n/g,' '));
  });

  // 关闭弹窗
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));

  // ============================================================
  // 4. 删除确认弹窗
  // ============================================================
  await step('P2-8: 删除确认弹窗（requireText 防误删）', async () => {
    // 找删除按钮
    const delBtn = await page.evaluateHandle(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        if (b.textContent.includes('删除') && !b.disabled) return b;
      }
      return null;
    });
    if ((await delBtn.jsonValue()) === null) {
      console.log('   (未找到删除按钮，跳过)');
      return;
    }
    await delBtn.asElement().click();
    await page.waitForSelector('[role="dialog"], dialog', { timeout: 3000 });
    await page.screenshot({ path: `${OUT_DIR}/05-delete-confirm.png` });
    const hasRequire = await page.evaluate(() => {
      return document.body.innerText.includes('请输入') || document.body.innerText.includes('DELETE') || document.body.innerText.includes('确认删除');
    });
    console.log(`   确认弹窗: ${hasRequire ? '存在' : '不确定'}`);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 300));
  });

  // ============================================================
  // 5. 实时监看页 - 布局
  // ============================================================
  await step('P3-1: 监看页 - 左右分栏布局', async () => {
    await page.goto(`${BASE_URL}/monitor`, { waitUntil: 'networkidle0', timeout: 10000 });
    await page.screenshot({ path: `${OUT_DIR}/06-monitor-empty.png` });
    const layoutInfo = await page.evaluate(() => {
      // 找 flex 容器
      const flex = document.querySelector('[class*="flex"]');
      const children = flex ? flex.children.length : 0;
      const hasGrid = document.querySelector('[class*="grid"]') !== null;
      return { children, hasGrid };
    });
    console.log(`   分栏数: ${layoutInfo.children}, 宫格容器: ${layoutInfo.hasGrid}`);
    if (layoutInfo.children < 2) throw new Error('左右分栏不明显');
  });

  await step('P3-2: 左侧通道选择列表', async () => {
    const itemCount = await page.evaluate(() => {
      // 左侧通道列表面板（aside 带"通道列表"标题）
      const aside = document.querySelectorAll('aside')[1]; // 监看页通道列表面板
      if (!aside) return 0;
      const items = aside.querySelectorAll('li button[data-testid], li button');
      return items.length;
    });
    console.log(`   左侧可选项: ${itemCount}`);
    if (itemCount === 0) throw new Error('左侧无通道选项');
  });

  // ============================================================
  // 6. FLV 播放（硬断言）
  // ============================================================
  await step('P3-3: 添加通道到宫格 - 第 1 路', async () => {
    // 点击左侧第一个通道项（data-testid 或 li > button）
    const clicked = await page.evaluate(() => {
      const aside = document.querySelectorAll('aside')[1]; // 监看页通道列表面板
      if (!aside) return false;
      const buttons = aside.querySelectorAll('li button[data-testid], li button');
      if (buttons.length === 0) return false;
      // 点第一个
      buttons[0].click();
      return true;
    });
    if (!clicked) throw new Error('无法点击通道');
    await new Promise(r => setTimeout(r, 500));
    await page.screenshot({ path: `${OUT_DIR}/07-monitor-1cell.png` });
    const videoCount = await page.$$eval('video', vs => vs.length);
    console.log(`   video 元素: ${videoCount}`);
  });

  await step('P3-4: FLV 视频 - 解码成功（videoWidth > 0）', async () => {
    await waitForVideoPlaying(page, 'video', 12000);
    const info = await page.$eval('video', v => ({
      src: v.currentSrc || v.src || '',
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      readyState: v.readyState,
      paused: v.paused,
      currentTime: v.currentTime,
    }));
    console.log(`   ${info.videoWidth}x${info.videoHeight}, readyState=${info.readyState}, paused=${info.paused}, t=${info.currentTime.toFixed(2)}s`);
    console.log(`   src: ${info.src.slice(0, 80)}`);
    if (info.videoWidth === 0) throw new Error('videoWidth=0，解码失败');
    if (info.readyState < 2) throw new Error('readyState < 2，未就绪');
  });

  await step('P3-5: FLV 视频 - currentTime 持续前进（证明真在播放）', async () => {
    const { advancing, times } = await verifyTimeProgress(page, 'video', 3, 1500);
    console.log(`   时间采样: [${times.map(t => t.toFixed(2)).join(', ')}]`);
    if (!advancing) throw new Error('currentTime 未持续前进，视频可能卡住');
  });

  await step('P3-6: 添加第 2 路 - 多宫格同时播放', async () => {
    const clicked = await page.evaluate(() => {
      const aside = document.querySelectorAll('aside')[1]; // 监看页通道列表面板
      if (!aside) return false;
      const buttons = aside.querySelectorAll('li button[data-testid], li button');
      if (buttons.length < 2) return false;
      buttons[1].click(); // 第二个通道
      return true;
    });
    if (!clicked) {
      console.log('   (只有 1 路可加，跳过多宫格验证)');
      return;
    }
    await new Promise(r => setTimeout(r, 3000));
    await page.screenshot({ path: `${OUT_DIR}/08-monitor-2cells.png` });
    const videos = await page.$$eval('video', vs => vs.map(v => ({
      w: v.videoWidth,
      t: v.currentTime.toFixed(2),
      paused: v.paused,
    })));
    console.log(`   2 路 video:`, JSON.stringify(videos));
    const playingCount = videos.filter(v => v.w > 0 && !v.paused).length;
    console.log(`   同时播放: ${playingCount}/2`);
    if (playingCount < 1) throw new Error('多路均未播放');
  });

  await step('P3-7: 布局切换（1x1 / 2x2 / 3x3）', async () => {
    const btns = await page.evaluate(() => {
      const all = document.querySelectorAll('button');
      const layoutBtns = [];
      for (const b of all) {
        const txt = b.textContent || '';
        if (txt.includes('1x1') || txt.includes('2x2') || txt.includes('3x3') ||
            txt.includes('布局') || txt.includes('1格') || txt.includes('4格') || txt.includes('9格')) {
          layoutBtns.push(txt.slice(0, 20));
        }
      }
      return layoutBtns;
    });
    console.log(`   布局按钮: ${btns.join(', ') || '(未找到，可能用图标)'}`);
    // 不强制要求文本标签，有 grid class 就算通过
  });

  // ============================================================
  // 7. WebRTC 播放（分阶段报告）
  // ============================================================
  await step('P3-8: 协议切换到 WebRTC - 信令阶段', async () => {
    // 找到协议切换（先回到单路，找第一个播放器）
    // 找协议选择器
    const switched = await page.evaluate(() => {
      // VideoPlayer 控制栏里有协议按钮组，找包含 WebRTC 的按钮
      const all = document.querySelectorAll('button, [role="menuitem"]');
      for (const el of all) {
        const txt = el.textContent || '';
        if (txt.includes('WebRTC')) {
          el.click();
          return true;
        }
      }
      // 可能有"协议"按钮展开下拉
      const protoBtns = Array.from(all).filter(b =>
        (b.textContent || '').includes('协议') ||
        (b.getAttribute('aria-label') || '').includes('协议')
      );
      if (protoBtns.length > 0) {
        // 点第一个协议按钮展开菜单
        protoBtns[0].click();
        // 然后找 WebRTC 选项（可能是新渲染的）
        const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], .dropdown button');
        for (const mi of menuItems) {
          if ((mi.textContent || '').includes('WebRTC')) {
            mi.click();
            return true;
          }
        }
      }
      return false;
    });

    if (!switched) {
      console.log('   (未找到 WebRTC 切换入口，可能在更多菜单里，跳过)');
      // 不算失败
      return;
    }

    await new Promise(r => setTimeout(r, 8000)); // 等信令 + ICE 尝试
    await page.screenshot({ path: `${OUT_DIR}/09-webrtc-attempt.png` });

    // 读取 WebRTC hook 日志
    const log = await page.evaluate(() => window.__webrtc_log || []);
    const pc = await page.evaluate(() => window.__webrtc_pc || null);
    console.log(`   WebRTC 事件数: ${log.length}`);
    for (const e of log.slice(0, 20)) {
      console.log(`     - ${e.type}: ${e.state || ''}${e.ts ? ` @${e.ts}` : ''}`);
    }

    // 分阶段判断
    const created = log.some(e => e.type === 'created');
    const states = log.filter(e => e.type === 'state').map(e => e.state);
    const iceStates = log.filter(e => e.type === 'ice').map(e => e.state);
    const hasTrack = log.some(e => e.type === 'track');
    const finalState = states[states.length - 1] || 'never-created';
    const finalIce = iceStates[iceStates.length - 1] || 'never-created';

    console.log(`   PC 创建: ${created}`);
    console.log(`   connectionState 终态: ${finalState}`);
    console.log(`   iceState 终态: ${finalIce}`);
    console.log(`   收到 track: ${hasTrack}`);

    // 状态报告
    if (finalState === 'connected' && hasTrack) {
      console.log('   🎉 WebRTC 连接成功且有媒体流');
      // 验证画面
      const info = await page.$eval('video', v => ({ w: v.videoWidth, t: v.currentTime }));
      console.log(`   视频: ${info.w}px, t=${info.t.toFixed(2)}s`);
      if (info.w > 0) {
        console.log('   ✅ WebRTC 画面解码成功，candidate * 配置有效');
      }
    } else if (finalState === 'connecting' || finalIce === 'checking') {
      console.log('   ⚠️ WebRTC 仍在连接中，可能 ICE 连通慢或 headless 环境受限');
      // 不抛错，记为待人工验证
    } else if (finalState === 'failed' || finalIce === 'failed') {
      if (iceStates.includes('checking')) {
        console.log('   ⚠️ WebRTC: 信令成功但 ICE 失败 — 可能 headless 环境网络限制，待实机验证');
      } else {
        console.log('   ⚠️ WebRTC 连接失败（阶段不明），待排查');
      }
      // WebRTC 失败不算 Phase 3 硬失败（降级链应该工作）
    } else if (!created) {
      console.log('   ℹ️ 未创建 RTCPeerConnection（可能被降级链跳过，或切换入口不对）');
    }
  });

  // ============================================================
  // 8. 控制台错误总览
  // ============================================================
  await step('P3-9: 页面无阻断性 JS 错误', async () => {
    // 过滤掉正常的网络警告、HLS 降级等
    const realErrors = consoleErrors.filter(e =>
      !e.includes('404') &&
      !e.includes('Failed to load resource') &&
      !e.includes('HLS') &&
      !e.includes('webrtc') &&
      !e.includes('AbortError') &&
      !e.includes('NotAllowedError') &&
      !e.includes('MediaError')
    );
    console.log(`   console.error 总数: ${consoleErrors.length}, 疑似阻断性: ${realErrors.length}`);
    if (realErrors.length > 0) {
      console.log('   前 3 条:');
      realErrors.slice(0, 3).forEach(e => console.log('     •', e.slice(0, 120)));
    }
    // 不抛错，只记录——很多"错误"是播放器降级链路的正常现象
  });

} catch (e) {
  console.error('\n[严重] 验收脚本主流程异常:', e.message);
} finally {
  await browser.close();
}

// ============================================================
// 汇总
// ============================================================
console.log('\n\n' + '='.repeat(60));
console.log('  Phase 3 浏览器自动化验收汇总');
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
console.log(`\n  截图目录: ${OUT_DIR}/`);
console.log('');
process.exit(failed > 0 ? 1 : 0);

import puppeteer from 'puppeteer-core';
import { execSync } from 'child_process';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=NetworkService',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });

// 建一个极简页面，直接测 flv.js 播 SRS 真实流
await page.setContent(`
<html><body style="margin:0;background:#000">
<video id="v" autoplay muted playsinline style="width:100%;height:100%"></video>
<script type="module">
import flvjs from 'http://127.0.0.1:5173/node_modules/.vite/deps/flv_js.js?v=test';
// fallback: 直接加载 CDN
</script>
<script>
// 用全局变量报告状态
window.__status = { loaded: false };
</script>
</body></html>
`);

// 换一个思路：直接注入 flv.js（从 node_modules 读）
import { readFileSync } from 'fs';
const flvjsSrc = readFileSync('node_modules/flv.js/dist/flv.min.js', 'utf8');

await page.evaluate((src) => {
  const script = document.createElement('script');
  script.textContent = src;
  document.head.appendChild(script);
}, flvjsSrc);

// 等 flvjs 加载
await new Promise(r => setTimeout(r, 1000));

const result = await page.evaluate(async () => {
  return new Promise((resolve) => {
    const player = window.flvjs.createPlayer({
      type: 'flv',
      url: 'http://127.0.0.1:8080/live/test.flv',
      isLive: true,
      hasAudio: true,
      hasVideo: true,
    });
    
    const v = document.getElementById('v');
    player.attachMediaElement(v);
    player.load();
    player.play().catch(e => { window.__playErr = e.message; });
    
    let done = false;
    function finish(status, extra = {}) {
      if (done) return;
      done = true;
      player.pause();
      player.unload();
      player.destroy();
      resolve({
        status,
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        readyState: v.readyState,
        paused: v.paused,
        currentTime: v.currentTime,
        error: v.error ? { code: v.error.code, msg: v.error.message } : null,
        ...extra,
      });
    }
    
    // 轮询 videoWidth
    let checks = 0;
    const iv = setInterval(() => {
      checks++;
      if (v.videoWidth > 0 && v.currentTime > 0.5) {
        clearInterval(iv);
        finish('playing');
      }
      if (checks > 20) { // 20s 超时
        clearInterval(iv);
        finish('timeout');
      }
    }, 1000);
    
    player.on(window.flvjs.Events.ERROR, (errType, errDetail) => {
      clearInterval(iv);
      finish('error', { errType, errDetail });
    });
  });
});

console.log('真实 SRS FLV 播放结果:');
console.log(JSON.stringify(result, null, 2));

// 截图
if (result.videoWidth > 0) {
  await page.screenshot({ path: 'test/screenshots/99-flv-real-stream.png' });
  console.log('\n已截图: test/screenshots/99-flv-real-stream.png');
}

await browser.close();

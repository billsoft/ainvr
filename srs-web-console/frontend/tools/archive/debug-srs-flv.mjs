import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});

// 方法 1: 直接用 video + MSE 播放（不用 flv.js，验证流本身）
// 方法 2: 验证 HTTP FLV 响应可达
const page = await browser.newPage();

// 先测 HTTP 请求
try {
  const res = await page.evaluate(async () => {
    const r = await fetch('http://127.0.0.1:8080/live/test.flv');
    const buf = await r.arrayBuffer();
    return { status: r.status, contentType: r.headers.get('content-type'), firstBytes: Array.from(new Uint8Array(buf.slice(0, 20))) };
  });
  console.log('SRS FLV 响应:', JSON.stringify(res));
} catch (e) {
  console.log('SRS FLV fetch 失败:', e.message);
}

// 用 flv.js 播真实流
await page.goto('data:text/html,<html><body><video id="v" controls autoplay></video><script src="https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js"></script></body></html>', 
  { waitUntil: 'load', timeout: 10000 });

const result = await page.evaluate(async () => {
  return new Promise(resolve => {
    const player = flvjs.createPlayer({
      type: 'flv',
      url: 'http://127.0.0.1:8080/live/test.flv',
      isLive: true,
    });
    player.attachMediaElement(document.getElementById('v'));
    player.load();
    player.play();
    
    let resolved = false;
    function done(status, info) {
      if (resolved) return;
      resolved = true;
      resolve({ status, ...info });
    }
    
    const v = document.getElementById('v');
    let t0 = null;
    setInterval(() => {
      if (v.videoWidth > 0 && v.currentTime > 0.5) {
        done('playing', { width: v.videoWidth, t: v.currentTime, readyState: v.readyState });
      }
    }, 500);
    
    player.on(flvjs.Events.ERROR, (err, errdet) => {
      done('error', { err, errdet });
    });
    
    setTimeout(() => done('timeout', { width: v.videoWidth, readyState: v.readyState, paused: v.paused, t: v.currentTime }), 15000);
  });
});

console.log('FLV 播放结果:', JSON.stringify(result, null, 2));

await browser.close();

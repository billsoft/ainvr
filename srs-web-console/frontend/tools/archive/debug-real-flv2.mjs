import puppeteer from 'puppeteer-core';
import { readFileSync } from 'fs';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });

// 捕获 console
const logs = [];
page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));

await page.setContent('<html><body style="margin:0"><video id="v" autoplay muted playsinline style="width:100%;height:400px;background:#000"></video></body></html>');

// 注入 flv.js
const flvjsSrc = readFileSync('node_modules/flv.js/dist/flv.min.js', 'utf8');
await page.evaluate(src => { const s = document.createElement('script'); s.textContent = src; document.head.appendChild(s); }, flvjsSrc);
await new Promise(r => setTimeout(r, 500));

console.log('flvjs 存在:', await page.evaluate(() => typeof window.flvjs));

const result = await page.evaluate(async () => {
  const logs2 = [];
  const v = document.getElementById('v');
  
  v.addEventListener('loadedmetadata', () => logs2.push('video: loadedmetadata ' + v.videoWidth + 'x' + v.videoHeight));
  v.addEventListener('loadeddata', () => logs2.push('video: loadeddata'));
  v.addEventListener('playing', () => logs2.push('video: playing'));
  v.addEventListener('error', () => logs2.push('video: error code=' + (v.error?.code)));
  v.addEventListener('waiting', () => logs2.push('video: waiting'));
  
  const player = flvjs.createPlayer({
    type: 'flv',
    url: 'http://127.0.0.1:8080/live/test.flv',
    isLive: true,
  });
  player.attachMediaElement(v);
  
  player.on(flvjs.Events.LOADING_COMPLETE, () => logs2.push('flv: loading_complete'));
  player.on(flvjs.Events.MEDIA_INFO, (info) => logs2.push('flv: media_info ' + JSON.stringify(info).slice(0,200)));
  player.on(flvjs.Events.ERROR, (t, d) => logs2.push('flv: error ' + t + ' ' + d));
  player.on(flvjs.Events.STATISTICS_INFO, (s) => logs2.push('flv: stats speed=' + s.speed + ' decoder=' + s.decoderType));
  
  player.load();
  try { await v.play(); } catch(e) { logs2.push('play() rejected: ' + e.message); }
  
  // 等 15 秒，采样
  const samples = [];
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    samples.push({ t: i+1, w: v.videoWidth, h: v.videoHeight, ct: v.currentTime.toFixed(2), rs: v.readyState, p: v.paused, ns: v.networkState });
  }
  
  player.pause();
  player.unload();
  player.destroy();
  
  return { logs: logs2, finalSample: samples[samples.length-1], samples };
});

console.log('最终状态:', JSON.stringify(result.finalSample, null, 2));
console.log('\n事件日志:');
result.logs.forEach(l => console.log('  ' + l));
console.log('\n每秒采样:');
result.samples.forEach(s => console.log(`  ${s.t}s: ${s.w}x${s.h} t=${s.ct} rs=${s.rs} paused=${s.p}`));

console.log('\nPage logs:');
logs.forEach(l => console.log('  ' + l));

// 截图
await page.screenshot({ path: 'test/screenshots/99-flv-real-stream.png' });
console.log('\n截图: test/screenshots/99-flv-real-stream.png');

await browser.close();

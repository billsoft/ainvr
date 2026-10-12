import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});

const page = await browser.newPage();

// 捕获所有网络请求
const requests = [];
page.on('request', req => { requests.push({ method: req.method(), url: req.url(), type: req.resourceType() }); });
const responses = [];
page.on('response', res => { responses.push({ status: res.status(), url: res.url(), fromCache: res.fromCache() }); });

await page.goto('http://127.0.0.1:5173/monitor', { waitUntil: 'networkidle0', timeout: 15000 });

// 点第一个通道
await page.evaluate(() => {
  const aside = document.querySelectorAll('aside')[1];
  aside.querySelectorAll('li button')[0].click();
});

// 等 8 秒
await new Promise(r => setTimeout(r, 8000));

// video 状态
const videoInfo = await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return {
    currentSrc: v.currentSrc,
    src: v.src,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    readyState: v.readyState,
    paused: v.paused,
    currentTime: v.currentTime,
    duration: v.duration,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
    networkState: v.networkState,
    buffered: v.buffered.length,
  };
});
console.log('VIDEO:', JSON.stringify(videoInfo, null, 2));

// 页面状态
const state = await page.evaluate(() => {
  return document.body.innerText.includes('加载') || document.body.innerText.includes('播放') || document.body.innerText.includes('错误')
    ? document.body.innerText.slice(0, 500) : '';
});
console.log('\n页面文本(前500):', state);

// FLV/WebSocket 请求
console.log('\n--- 相关网络请求 ---');
for (const r of requests.filter(r => r.url.includes('.flv') || r.url.includes(':8080') || r.url.includes('stream') || r.url.includes('live/'))) {
  console.log('REQ:', r.method, r.type, r.url.slice(0, 100));
}
console.log('\n--- 相关响应 ---');
for (const r of responses.filter(r => r.url.includes('.flv') || r.url.includes(':8080') || r.url.includes('live/'))) {
  console.log('RES:', r.status, r.url.slice(0, 100));
}

await browser.close();

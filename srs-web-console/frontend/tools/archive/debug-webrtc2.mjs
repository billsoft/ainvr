import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--allow-insecure-localhost',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });

// hook WebRTC 记录候选
await page.evaluateOnNewDocument(() => {
  window.__webrtc_log = [];
  const _RTCP = window.RTCPeerConnection;
  window.RTCPeerConnection = function(cfg, cons) {
    const pc = new _RTCP(cfg, cons);
    window.__webrtc_pc = pc;
    window.__webrtc_log.push({ type: 'created', config: cfg });
    pc.addEventListener('icecandidate', e => {
      window.__webrtc_log.push({ type: 'icecandidate', cand: e.candidate?.candidate?.slice(0, 80) || '(null)' });
    });
    pc.addEventListener('connectionstatechange', () => {
      window.__webrtc_log.push({ type: 'conn_state', state: pc.connectionState });
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      window.__webrtc_log.push({ type: 'ice_state', state: pc.iceConnectionState });
    });
    return pc;
  };
});

await page.setContent('<html><body><video id="v" autoplay muted playsinline style="width:100%;height:400px"></video><pre id="log" style="color:#0f0;font:11px monospace;max-height:200px;overflow:auto"></pre></body></html>');

const result = await page.evaluate(async () => {
  const v = document.getElementById('v');
  const log = msg => { document.getElementById('log').textContent += msg + '\n'; };
  
  try {
    const streamUrl = 'webrtc://127.0.0.1/live/test';
    const apiUrl = 'http://127.0.0.1:1985/rtc/v1/play/';
    
    // 1. 创建 PeerConnection（接收方，需要收流）
    const pc = new RTCPeerConnection({ iceServers: [] });
    
    // 收流
    pc.ontrack = e => {
      log('ontrack: ' + e.track.kind);
      if (e.streams[0]) v.srcObject = e.streams[0];
    };
    
    // SRS 是 offer 方？不对 —— 播放时浏览器发 offer，SRS 回 answer
    // SRS 文档：POST play/ with client offer → server answer
    // 需要创建 offer（我们作为接收方也要 offer，SRS 是 answer 方）
    // 但播放场景下我们是 recvonly，所以 createOffer 也可以
    
    // 添加接收收发器（必须在 createOffer 前）
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('offer created, len=' + offer.sdp.length);
    
    // 等 ICE 收集完成（trickle 或 wait）
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') resolve();
      else pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve();
      });
      // 最多等 3 秒
      setTimeout(resolve, 3000);
    });
    
    log('ice state: ' + pc.iceGatheringState + ', local sdp len=' + pc.localDescription.sdp.length);
    log('first 300 chars of SDP:\n' + pc.localDescription.sdp.slice(0, 300));
    
    // 2. 发 offer 给 SRS
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api: apiUrl,
        clientip: null,
        sdp: pc.localDescription.sdp,
        streamurl: streamUrl,
      }),
    });
    const data = await resp.json();
    log('SRS response: code=' + data.code);
    if (data.code !== 0) {
      log('SRS error data: ' + JSON.stringify(data));
      return { status: 'signaling_error', code: data.code, data };
    }
    
    // 3. 设置远程 SDP
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
    log('remote answer set');
    
    // 4. 等连接
    return new Promise(resolve => {
      let done = false;
      function finish(status) {
        if (done) return;
        done = true;
        setTimeout(async () => {
          const stats = await pc.getStats().then(s => {
            const r = {};
            s.forEach(v => {
              if (v.type === 'inbound-rtp' && v.mediaType === 'video') {
                r.framesDecoded = v.framesDecoded;
                r.bytesReceived = v.bytesReceived;
                r.packetsReceived = v.packetsReceived;
              }
              if (v.type === 'candidate-pair' && v.state === 'succeeded') {
                r.pairState = v.state;
              }
            });
            return r;
          }).catch(() => ({}));
          
          resolve({
            status,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentTime: v.currentTime,
            readyState: v.readyState,
            paused: v.paused,
            connectionState: pc.connectionState,
            iceState: pc.iceConnectionState,
            stats,
          });
          pc.close();
        }, 3000);
      }
      
      pc.addEventListener('connectionstatechange', () => {
        log('conn: ' + pc.connectionState);
        if (pc.connectionState === 'connected') finish('connected');
        if (pc.connectionState === 'failed') finish('failed');
        if (pc.connectionState === 'closed') finish('closed');
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        log('ice: ' + pc.iceConnectionState);
      });
      
      setTimeout(() => finish('timeout'), 15000);
    });
    
  } catch (e) {
    return { status: 'exception', error: e.message, stack: e.stack?.slice(0, 300) };
  }
});

console.log('\n========== WebRTC 测试结果 ==========');
console.log(JSON.stringify(result, null, 2));

// 读取 hook 日志
const hookLog = await page.evaluate(() => window.__webrtc_log);
console.log('\nWebRTC hook 日志:');
hookLog.forEach(e => console.log('  ' + e.type + ': ' + (e.state || e.cand || JSON.stringify(e.config?.iceServers))));

await page.screenshot({ path: 'test/screenshots/99-webrtc-real-stream.png' });
console.log('\n截图: test/screenshots/99-webrtc-real-stream.png');

await browser.close();

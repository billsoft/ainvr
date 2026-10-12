import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/snap/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--allow-insecure-localhost',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });

// hook WebRTC
await page.evaluateOnNewDocument(() => {
  window.__webrtc_log = [];
  const _RTCP = window.RTCPeerConnection;
  window.RTCPeerConnection = function(cfg, cons) {
    const pc = new _RTCP(cfg, cons);
    window.__webrtc_pc = pc;
    window.__webrtc_log.push({ type: 'created', config: cfg });
    ['connectionstatechange','iceconnectionstatechange','icegatheringstatechange','track','signalingstatechange'].forEach(ev => {
      pc.addEventListener(ev, () => {
        window.__webrtc_log.push({ 
          type: ev, 
          state: ev === 'connectionstatechange' ? pc.connectionState :
                 ev === 'iceconnectionstatechange' ? pc.iceConnectionState :
                 ev === 'icegatheringstatechange' ? pc.iceGatheringState :
                 ev === 'signalingstatechange' ? pc.signalingState : 'n/a',
          ts: Date.now() 
        });
      });
    });
    return pc;
  };
});

await page.setContent('<html><body style="margin:0"><video id="v" autoplay muted playsinline style="width:100%;height:400px;background:#000"></video><pre id="log" style="color:#0f0;font:12px monospace"></pre></body></html>');

// 注入 webrtc 播放逻辑（按 SRS 标准流程）
const result = await page.evaluate(async () => {
  const v = document.getElementById('v');
  const log = msg => { 
    const p = document.getElementById('log');
    p.textContent += msg + '\n';
  };
  
  try {
    // 1. 请求 SRS 信令
    const apiUrl = 'http://127.0.0.1:1985/rtc/v1/play/';
    const streamUrl = 'webrtc://127.0.0.1/live/test';
    
    log('1. 请求信令: ' + apiUrl);
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api: apiUrl, clientip: null, sdp: '', streamurl: streamUrl }),
    });
    const data = await resp.json();
    log('2. 信令响应: code=' + data.code + ', sdp长度=' + (data.sdp?.length || 0));
    if (data.code !== 0) {
      log('   错误: ' + JSON.stringify(data));
      return { status: 'signaling_error', data };
    }
    
    // 2. 创建 PeerConnection
    const config = { iceServers: [] };
    const pc = new RTCPeerConnection(config);
    
    // track 事件
    pc.ontrack = (e) => {
      log('3. 收到 track: ' + e.track.kind + ' ' + e.streams.length + ' streams');
      if (e.streams[0]) {
        v.srcObject = e.streams[0];
        v.play().catch(err => log('play() error: ' + err.message));
      }
    };
    
    // 3. 设置远程 SDP
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
    log('4. 远程 SDP 已设置');
    
    // 4. 创建 answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    log('5. 本地 answer 已创建');
    
    // 5. 发送 answer 给 SRS
    const resp2 = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api: apiUrl, clientip: null, sdp: answer.sdp, streamurl: streamUrl }),
    });
    const data2 = await resp2.json();
    log('6. Answer 响应: code=' + data2.code);
    
    // 6. 等连接建立
    const start = Date.now();
    return new Promise(resolve => {
      let resolved = false;
      function finish(status) {
        if (resolved) return;
        resolved = true;
        // 再等 3 秒看画面
        setTimeout(async () => {
          const stats = pc.getStats ? await pc.getStats().then(s => {
            const result = {};
            s.forEach(v => {
              if (v.type === 'inbound-rtp' && v.mediaType === 'video') {
                result.framesDecoded = v.framesDecoded;
                result.bytesReceived = v.bytesReceived;
                result.codec = v.codecId;
              }
              if (v.type === 'candidate-pair' && v.state === 'succeeded') {
                result.localCandidate = v.localCandidateId;
                result.remoteCandidate = v.remoteCandidateId;
              }
            });
            return result;
          }).catch(() => ({})) : {};
          
          resolve({
            status,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            currentTime: v.currentTime,
            readyState: v.readyState,
            paused: v.paused,
            elapsed: (Date.now() - start) / 1000,
            connectionState: pc.connectionState,
            iceState: pc.iceConnectionState,
            iceGathering: pc.iceGatheringState,
            stats,
            log: window.__webrtc_log.map(e => `${e.type}:${e.state}`).join(' -> '),
          });
          pc.close();
        }, 3000);
      }
      
      pc.addEventListener('connectionstatechange', () => {
        log('   conn state: ' + pc.connectionState);
        if (pc.connectionState === 'connected') finish('connected');
        if (pc.connectionState === 'failed') finish('failed');
        if (pc.connectionState === 'disconnected') finish('disconnected');
      });
      
      pc.addEventListener('iceconnectionstatechange', () => {
        log('   ice state: ' + pc.iceConnectionState);
      });
      
      // 超时
      setTimeout(() => finish('timeout'), 15000);
    });
    
  } catch (e) {
    return { status: 'exception', error: e.message, stack: e.stack?.slice(0, 200) };
  }
});

console.log('\n========== WebRTC 测试结果 ==========');
console.log(JSON.stringify(result, null, 2));

// 截图
await page.screenshot({ path: 'test/screenshots/99-webrtc-real-stream.png' });
console.log('\n截图: test/screenshots/99-webrtc-real-stream.png');

await browser.close();

import type { FlowFrame, FlowFrames } from './ptzFlowCenter';

export class CenterObservationError extends Error {}

// Capture only the decoded video, never detection/OSD DOM overlays. The native
// service owns median denoising and optical-flow filtering; do not blur here.
export async function captureFlowView(video: HTMLVideoElement, signal: AbortSignal): Promise<FlowFrames> {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 384;
  const context = canvas.getContext('2d');
  const width = video.videoWidth, height = video.videoHeight;
  const src = video.currentSrc, stream = video.srcObject;
  const invalid = () => new CenterObservationError('光流标定需要正在播放的实时画面。');
  if (!context || !width || !height) throw invalid();
  function read(): FlowFrame {
    if (video.error || video.paused || video.ended || video.seeking || video.readyState < 2 ||
        video.videoWidth !== width || video.videoHeight !== height ||
        video.currentSrc !== src || video.srcObject !== stream) throw invalid();
    if (stream && 'getVideoTracks' in stream &&
        !stream.getVideoTracks().some(t => t.readyState === 'live' && t.enabled && !t.muted)) throw invalid();
    context!.drawImage(video, 0, 0, 512, 384);
    const encoded = canvas.toDataURL('image/jpeg', .94);
    if (!encoded.startsWith('data:image/jpeg;base64,')) throw invalid();
    return {jpeg: encoded.slice(23), at: performance.now(), width: 512, height: 384};
  }
  async function fresh(signal: AbortSignal, timeoutMs = 750): Promise<FlowFrame> {
    signal.throwIfAborted();
    if (typeof video.requestVideoFrameCallback !== 'function') throw invalid();
    await new Promise<void>((resolve, reject) => {
      const handle = video.requestVideoFrameCallback(() => { cleanup(); resolve(); });
      const timer = setTimeout(() => cancel(new CenterObservationError('等待光流采样画面超时。')), timeoutMs);
      function cleanup() { clearTimeout(timer); signal.removeEventListener('abort', abort); }
      function cancel(reason: unknown) { cleanup(); video.cancelVideoFrameCallback(handle); reject(reason); }
      function abort() { cancel(signal.reason); }
      signal.addEventListener('abort', abort, {once: true});
    });
    signal.throwIfAborted();
    return read();
  }
  return {initial: await fresh(signal), fresh};
}

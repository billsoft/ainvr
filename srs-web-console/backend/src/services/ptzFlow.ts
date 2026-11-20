import { z } from 'zod';
import { PtzError } from '../store/ptzStore.js';
import { endpoint, limitedBytes, type InternalServiceConnection } from './internalServiceHttp.js';
import { jpegDimensions } from './searchContract.js';

const maxFrameBytes = 2 * 1024 * 1024;
// Native owns the 15 s inference deadline; leave time to receive its response.
export const ptzFlowTimeoutMs = 17_000;
const maxEncoded = 4 * Math.ceil(maxFrameBytes / 3);
export const flowBodyLimit = 2 * maxEncoded + 1024;
const frame = z.string().refine(value => {
  if (!value.length || value.length > maxEncoded || value.length % 4 !== 0) return false;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxFrameBytes || bytes.toString('base64') !== value) return false;
  const size = jpegDimensions(bytes);
  return size?.width === 512 && size.height === 384;
});
export const flowFrames = z.object({frame0: frame, frame1: frame}).strict();
const result = z.object({
  dx: z.number().finite(), dy: z.number().finite(), width: z.literal(512), height: z.literal(384),
  inliers: z.number().int().min(0).max(512 * 384), validRatio: z.number().finite().min(0).max(1),
  spread: z.number().finite().nonnegative(), backend: z.literal('neuflow-bpu'),
});
const unavailable = () => new PtzError('ptz_flow_unavailable', 503);
const busy = () => new PtzError('ptz_flow_busy', 429);

export class PtzFlow {
  private active = false;
  constructor(private readonly connection: () => Promise<InternalServiceConnection>) {}

  async measure(frames: z.infer<typeof flowFrames>, checkContext: () => Promise<void>) {
    if (this.active) throw busy();
    this.active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, ptzFlowTimeoutMs);
    });
    const signal = controller.signal;
    const run = async () => {
      await checkContext();
      signal.throwIfAborted();
      const config = await this.connection();
      signal.throwIfAborted();
      const response = await fetch(endpoint(config, '/internal/ptz/flow'), {
        method: 'POST', redirect: 'error', signal,
        headers: {'content-type': 'application/json', 'x-service-token': config.apiToken},
        body: JSON.stringify({frame0: frames.frame0, frame1: frames.frame1}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 413) throw new PtzError('ptz_flow_too_large', 413);
        if (response.status === 422) throw new PtzError('ptz_flow_invalid', 422);
        throw response.status === 429 ? busy() : unavailable();
      }
      const motion = result.parse(JSON.parse((await limitedBytes(response, 16384)).toString()));
      signal.throwIfAborted();
      await checkContext();
      return motion;
    };
    // Keep admission closed until even a non-abortable DB lookup has drained.
    const work = run().finally(() => { clearTimeout(timer); this.active = false; });
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      if (error instanceof PtzError && error.code !== 'ptz_ai_unavailable') throw error;
      throw unavailable();
    }
  }
}

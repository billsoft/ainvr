import { z } from 'zod';
import { endpoint, limitedBytes, type InternalServiceConnection } from './internalServiceHttp.js';
import { FacesError, facesUnavailable, facesId, facesPin } from './facesContract.js';

const statusSchema = z.object({ schema: z.literal('ainvr.face-runtime.v1'), ready: z.boolean(), can_extract: z.boolean(),
  embedding_model: z.enum(['face-embed-mbf', 'face-embed-r50']).nullable(), model_space_hash: facesPin.nullable(), detector_sha256: facesPin.nullable(),
  reason: z.string().nullable(), accuracy_verified: z.literal(false), configuration_revision: z.number().int().nonnegative().optional(),
  apply_pending: z.boolean().optional(), persisted: z.boolean().optional(),
  configuration: z.object({ enabled: z.boolean(), detector_model: z.enum(['face-det-scrfd-500m', 'face-det-scrfd-2g5']), embedding_model: z.enum(['face-embed-mbf', 'face-embed-r50']), revision: z.number().int().nonnegative() }).optional(),
}).strip();
const extractionSchema = z.object({
  schema: z.literal('ainvr.face-extraction.v1'), status: z.enum(['extracted', 'no_face', 'multiple_faces', 'quality_rejected']),
  request_id: facesId, model_space_hash: facesPin, detector_sha256: facesPin, jpeg_sha256: facesPin,
  accuracy_verified: z.literal(false), visibility: z.literal('internal_only'),
  quality: z.object({ accepted: z.boolean(), scope: z.literal('geometry_only'), reason: z.string(),
    blur_assessed: z.literal(false), occlusion_assessed: z.literal(false), liveness_assessed: z.literal(false), accuracy_verified: z.literal(false) }).passthrough(),
  embedding: z.array(z.number().finite()).length(512).optional(), dimensions: z.literal(512).optional(), normalization: z.literal('l2').optional(), input_spec_version: z.string().optional(),
}).strip();
export type FacesExtraction = z.infer<typeof extractionSchema>;
export type FacesExtractorStatus = z.infer<typeof statusSchema>;
export interface FacesExtractionInput { request_id: string; model_space_hash: string; detector_sha256: string; jpeg_sha256: string; expires_ms: number }

/** ONLY a hardware JPEG->embedding client. No native library/history/search APIs. */
export class FacesNativeClient {
  constructor(private readonly connection: () => Promise<InternalServiceConnection | null>) {}
  private async response(path: string, image?: Buffer, metadata?: FacesExtractionInput, configuration?: unknown) {
    const config = await this.connection(); if (!config) throw facesUnavailable();
    try {
      const response = await fetch(endpoint(config, path), { method: image || configuration ? 'POST' : 'GET', redirect: 'error',
        headers: { 'x-service-token': config.apiToken, ...(image ? { 'content-type': 'image/jpeg', 'x-ainvr-face': JSON.stringify(metadata) } : configuration ? { 'content-type': 'application/json' } : {}) },
        body: image ? new Uint8Array(image) : configuration ? JSON.stringify(configuration) : undefined, signal: AbortSignal.timeout(config.timeoutMs) });
      const raw = JSON.parse((await limitedBytes(response, 65536)).toString());
      if (!response.ok) {
        const errors: Record<string, [number, string]> = {
          face_busy: [429, '人脸提取正在处理其他请求，请稍后重试'], face_model_space_changed: [409, '模型空间已变化，请核对模型后重试'],
          face_timeout: [504, '人脸硬件处理超时，输入已保留'], face_not_authorized: [503, '人脸硬件调用授权尚未就绪'],
        };
        const value = errors[raw?.error?.code];
        if (value) throw new FacesError(raw.error.code, value[1], value[0]);
        throw facesUnavailable();
      }
      return raw;
    } catch (error) { if (error instanceof FacesError) throw error; throw facesUnavailable(); }
  }
  async status(): Promise<FacesExtractorStatus> {
    const result = statusSchema.safeParse(await this.response('/v1/faces/extractor/status'));
    if (!result.success) throw facesUnavailable();
    return result.data;
  }
  async configure(input: { enabled: boolean; detector_model: 'face-det-scrfd-500m' | 'face-det-scrfd-2g5'; embedding_model: 'face-embed-mbf' | 'face-embed-r50'; expected_revision: number }): Promise<FacesExtractorStatus> {
    const result = statusSchema.safeParse(await this.response('/v1/faces/extractor/configure', undefined, undefined, input));
    if (!result.success) throw facesUnavailable();
    return result.data;
  }
  async extract(bytes: Buffer, input: FacesExtractionInput): Promise<FacesExtraction> {
    const parsed = extractionSchema.safeParse(await this.response('/v1/faces/extract', bytes, input));
    if (!parsed.success) throw new FacesError('faces_native_invalid_response', '人脸硬件返回格式不正确', 503);
    const result = parsed.data;
    if (result.request_id !== input.request_id || result.model_space_hash !== input.model_space_hash || result.detector_sha256 !== input.detector_sha256 || result.jpeg_sha256 !== input.jpeg_sha256) throw new FacesError('faces_native_invalid_response', '人脸硬件返回的图像或模型标识不一致', 503);
    if (result.status === 'extracted') {
      const norm = Math.sqrt((result.embedding ?? []).reduce((sum, value) => sum + value * value, 0));
      if (!result.quality.accepted || !result.embedding || result.dimensions !== 512 || result.normalization !== 'l2' || Math.abs(norm - 1) > 0.02) throw new FacesError('faces_native_invalid_response', '人脸特征维度或归一化校验失败', 503);
    } else if (result.embedding) throw new FacesError('faces_native_invalid_response', '未通过质量检查的结果不能包含特征', 503);
    return result;
  }
}

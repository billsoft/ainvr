import type { Channel } from '../types/channel.js';

export interface InputFields {
  streamName?: string;
  app?: string;
  upstreamProtocol?: string;
  rtspUrl?: string;
  rtspTransport?: 'tcp' | 'udp';
  inputUsername?: string;
  inputPassword?: string;
  inputEnabled?: boolean;
}
export class InputValidationError extends Error { readonly statusCode = 400; }

export function normalizeInput(input: InputFields): { publicUrl?: string; secret?: string } {
  for (const value of [input.streamName, input.app]) {
    if (value !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
      throw new InputValidationError('流标识只能包含字母、数字、下划线和短横线');
  }
  if (input.upstreamProtocol !== 'rtsp') {
    if (input.rtspUrl || input.inputUsername || input.inputPassword) throw new InputValidationError('仅摄像头拉流可以设置源地址和凭据');
    return {};
  }
  if (!input.rtspUrl || input.rtspUrl.length > 2048 || /[\x00-\x20]/.test(input.rtspUrl)) throw new InputValidationError('请输入有效的摄像头地址');
  let u: URL;
  try { u = new URL(input.rtspUrl); } catch { throw new InputValidationError('请输入有效的摄像头地址'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'rtsp:' || !host || u.hash || host === 'localhost' || host === 'metadata.google.internal' ||
      /^(127\.|169\.254\.|0\.|22[4-9]\.|23\d\.)/.test(host) || ['::','::1'].includes(host)) throw new InputValidationError('摄像头地址不允许访问该目标');
  if (input.inputUsername !== undefined) u.username = input.inputUsername;
  if (input.inputPassword !== undefined) u.password = input.inputPassword;
  const secret = u.toString();
  u.username = ''; u.password = '';
  return { publicUrl: u.toString(), secret };
}

export function hasVideo(s: any): boolean {
  return !!s?.publish?.active && (typeof s.frames === 'number' ? s.frames > 0 : !!s.video?.codec);
}

export function safeChannel<T extends Channel>(ch: T): T {
  const { sourceRef: _ref, ...rest } = ch;
  if (rest.rtspUrl) {
    try { const u = new URL(rest.rtspUrl); u.username = ''; u.password = ''; rest.rtspUrl = u.toString(); }
    catch { delete rest.rtspUrl; }
  }
  return rest as T;
}

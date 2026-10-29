// getRandomValues remains available on HTTP LAN origins where randomUUID is not.
export function newOperationId(format: 'token' | 'uuid' = 'token'): string {
  const bytes = new Uint8Array(16)
  const unavailable = '当前浏览器无法生成安全请求标识，请更换支持安全随机数的浏览器后重试'
  try {
    if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error(unavailable)
    globalThis.crypto.getRandomValues(bytes)
  } catch {
    throw new Error(unavailable)
  }
  if (format === 'uuid') {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
  }
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return format === 'uuid'
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : hex
}

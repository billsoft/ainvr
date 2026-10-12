export const MAX_LICENSE_FILE_BYTES = 16_384

/** Files contain the same signed text accepted by the existing preview API. */
export function readLicenseText(text: string): string {
  const key = text.replace(/^\uFEFF/, '').trim()
  if (key.length > 8192 || !/^AINVR-LIC3-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('文件不是有效的注册码文件，请选择供应商提供的 .lic 或 .txt 文件')
  }
  return key
}

export function downloadRequest(request: string, machineCode: string): void {
  const name = machineCode.replace(/[^A-Za-z0-9-]/g, '') || 'device'
  const url = URL.createObjectURL(new Blob([request + '\n'], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `AINVR-request-${name}.txt`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Leave the URL alive until the browser has begun handling the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

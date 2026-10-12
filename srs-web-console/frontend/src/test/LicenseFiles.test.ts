import { describe, expect, it, vi } from 'vitest'
import { downloadRequest, readLicenseText } from '@/pages/License/licenseFiles'

describe('license file import', () => {
  it('accepts issuer text with Windows BOM and line ending', () => {
    expect(readLicenseText('\uFEFFAINVR-LIC3-YWJj.ZGVm\r\n')).toBe('AINVR-LIC3-YWJj.ZGVm')
  })
  it.each(['', 'AINVR-REQ3-abc', '<html>error</html>', 'AINVR-LIC3-abc.def\nAINVR-LIC3-ghi.jkl'])('rejects other files: %s', value => {
    expect(() => readLicenseText(value)).toThrow()
  })
  it('rejects an oversized token before preview', () => {
    expect(() => readLicenseText(`AINVR-LIC3-${'a'.repeat(8192)}.abc`)).toThrow()
  })
})


describe('license request download', () => {
  it('downloads the complete request as plain text with a safe filename', async () => {
    let content: Blob | undefined
    const create = vi.fn((blob: Blob) => { content = blob; return 'blob:test-request' })
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('AINVR-request-DEVICE.txt')
      expect(this.href).toBe('blob:test-request')
    })
    try {
      downloadRequest('AINVR-REQ3-full-installation-request', '../DEVICE')
      expect(click).toHaveBeenCalledOnce()
      expect(content?.type).toBe('text/plain;charset=utf-8')
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(content!)
      })
      expect(text).toBe('AINVR-REQ3-full-installation-request\n')
      expect(document.querySelector('a[download]')).toBeNull()
      expect(revoke).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 1050))
      expect(revoke).toHaveBeenCalledWith('blob:test-request')
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

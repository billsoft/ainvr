import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StorageDirectoryPicker } from '@/components/StorageDirectoryPicker'
vi.mock('@/api/storageService', () => ({ storageBytes: () => '100 GB', storageService: {
  volumes: async () => ({ volumes: [
    { id: 'system', device: '/dev/system', system: true, selectable: false },
    { id: 'usb', device: '/dev/sdb', system: false, selectable: true, label: '测试盘', transport: 'usb', mountPath: '/media/test', availableBytes: 100 },
  ] }),
  directories: async () => ({ directories: ['recordings'], truncated: false }),
} }))
describe('录像目录选择', () => {
  it('浏览不标记配置改变，明确使用才改变；系统盘不可选', async () => {
    const change = vi.fn(), parentChange = vi.fn()
    render(<div onChange={parentChange}><StorageDirectoryPicker value="/old" onChange={change} /></div>)
    await screen.findByRole('option', { name: /测试盘/ })
    expect(screen.queryByRole('option', { name: /system/ })).toBeNull()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'usb' } })
    fireEvent.click(await screen.findByRole('button', { name: '📁 recordings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此目录' })).not.toBeDisabled())
    expect(change).not.toHaveBeenCalled(); expect(parentChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '使用此目录' }))
    expect(change).toHaveBeenCalledWith('/media/test/recordings')
  })
  it('supports a shared stable-volume selection without changing the legacy recording contract', async () => {
    const select = vi.fn()
    render(<StorageDirectoryPicker value="" label="选择索引磁盘" defaultRelativePath="ainvr/search-index" onSelection={select} hint="搜索索引目录" />)
    await screen.findByRole('option', { name: /测试盘/ })
    fireEvent.change(screen.getByRole('combobox', { name: '选择索引磁盘' }), { target: { value: 'usb' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '使用此目录' })).not.toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '使用此目录' }))
    expect(select).toHaveBeenCalledWith({ volumeId: 'usb', relativePath: 'ainvr/search-index' })
    expect(screen.getByText('搜索索引目录')).toBeInTheDocument()
  })
})

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'

afterEach(cleanup)

it('returns focus to the remaining parent when discarding removes the opener', () => {
  function Host() {
    const [editing, setEditing] = useState(true)
    const [open, setOpen] = useState(false)
    return <>
      <button>背景操作</button>
      <div role="dialog" aria-modal="true" aria-label="通道向导" tabIndex={-1}>
        <button>返回通道设置</button>
        {editing && <button onClick={() => setOpen(true)}>取消设备编辑</button>}
      </div>
      <ConfirmDialog open={open} title="放弃设备" onConfirm={() => setEditing(false)} onClose={() => setOpen(false)} />
    </>
  }
  render(<Host />)
  const opener = screen.getByRole('button', { name: '取消设备编辑' })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.click(screen.getByTestId('confirm-ok'))
  expect(screen.queryByRole('button', { name: '取消设备编辑' })).toBeNull()
  expect(screen.getByRole('button', { name: '返回通道设置' })).toHaveFocus()
})

it('keeps keyboard focus inside confirmation and restores the opener on cancel', () => {
  function Host() {
    const [open, setOpen] = useState(false)
    return <>
      <button onClick={() => setOpen(true)}>打开确认</button>
      <ConfirmDialog open={open} title="核对修改" onConfirm={() => {}} onClose={() => setOpen(false)} />
    </>
  }
  render(<Host />)
  const opener = screen.getByRole('button', { name: '打开确认' })
  opener.focus()
  fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: '核对修改' })
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
  const close = within(dialog).getByRole('button', { name: '关闭' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(screen.getByTestId('confirm-ok')).toHaveFocus()
  fireEvent.keyDown(screen.getByTestId('confirm-ok'), { key: 'Tab' })
  expect(close).toHaveFocus()
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(opener).toHaveFocus()
})

it('closing a nested confirmation does not close or submit its parent', () => {
  const parent = vi.fn(), onClose = vi.fn(), onConfirm = vi.fn()
  render(<div onKeyDown={parent}>
    <ConfirmDialog open title="嵌套确认" onConfirm={onConfirm} onClose={onClose} />
  </div>)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  expect(parent).not.toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('handles Escape after focus leaves a non-focusable part of the dialog', () => {
  const onClose = vi.fn(), onConfirm = vi.fn()
  render(<ConfirmDialog open title="核对修改" onConfirm={onConfirm} onClose={onClose} />)
  ;(document.activeElement as HTMLElement).blur()
  expect(document.activeElement).toBe(document.body)
  fireEvent.keyDown(document.body, { key: 'Tab' })
  expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
  ;(document.activeElement as HTMLElement).blur()
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('blocks close, Escape and repeat confirmation while an operation is busy', () => {
  const onClose = vi.fn(), onConfirm = vi.fn()
  render(<ConfirmDialog open busy title="正在保存" onConfirm={onConfirm} onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  fireEvent.click(screen.getByTestId('confirm-ok'))
  expect(onClose).not.toHaveBeenCalled()
  expect(onConfirm).not.toHaveBeenCalled()
})

it('clears the required text when reopened and never confirms on Escape', () => {
  const onClose = vi.fn(), onConfirm = vi.fn()
  const props = { title: '删除确认', requireText: '目标名称', onConfirm, onClose }
  const view = render(<ConfirmDialog {...props} open />)
  expect(screen.getByTestId('confirm-input')).toHaveFocus()
  fireEvent.change(screen.getByTestId('confirm-input'), { target: { value: '目标名称' } })
  expect(screen.getByTestId('confirm-ok')).toBeEnabled()
  view.rerender(<ConfirmDialog {...props} open={false} />)
  view.rerender(<ConfirmDialog {...props} open />)
  expect(screen.getByTestId('confirm-ok')).toBeDisabled()
  fireEvent.keyDown(screen.getByTestId('confirm-input'), { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  expect(onConfirm).not.toHaveBeenCalled()
})

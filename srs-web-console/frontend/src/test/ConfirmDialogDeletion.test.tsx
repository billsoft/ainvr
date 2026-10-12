import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from '@/components/modals/ConfirmDialog'

describe('AI deletion confirmation lifecycle', () => {
  it('requires the channel name and keeps the dialog open while the backend owns deletion', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<ConfirmDialog open title="删除 AI 通道" requireText="大门口" autoClose={false}
      onConfirm={onConfirm} onClose={onClose} />)
    expect(screen.getByTestId('confirm-ok')).toBeDisabled()
    fireEvent.change(screen.getByTestId('confirm-input'), { target: { value: '大门口' } })
    fireEvent.click(screen.getByTestId('confirm-ok'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('prevents duplicate submission and dismissal while deleting, then permits retry', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    const props = { open: true, title: '删除 AI 通道', autoClose: false, onConfirm, onClose }
    const view = render(<ConfirmDialog {...props} busy />)
    fireEvent.click(screen.getByTestId('confirm-ok'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    view.rerender(<ConfirmDialog {...props} busy={false} />)
    fireEvent.click(screen.getByTestId('confirm-ok'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})

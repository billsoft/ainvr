import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { RouteErrorBoundary } from '@/components/common/RouteErrorBoundary'

function Boom(): never {
  throw new Error('组件渲染期炸了')
}

describe('RouteErrorBoundary', () => {
  it('回归：子路由渲染期抛错时展示错误态而不是让整棵树白屏', async () => {
    // 真实场景里全站没有任何 ErrorBoundary，任意页面一次渲染期异常会把
    // 整个 React 树连根卸载——这里验证挂上 errorElement 之后不再是这样。
    vi.spyOn(console, 'error').mockImplementation(() => {}) // React 会把这类错误打到 console.error，测试期静音
    const router = createMemoryRouter(
      [{ path: '/', element: <Boom />, errorElement: <RouteErrorBoundary /> }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)

    expect(await screen.findByText('页面出错了')).toBeInTheDocument()
    expect(screen.getByText('组件渲染期炸了')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回首页' })).toBeInTheDocument()
  })
})

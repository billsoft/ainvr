import { describe, expect, it } from 'vitest'

// 弹窗只能点「取消」或右上角关闭（2026-10-09 产品要求）：点到遮罩/窗体边缘或误按 Esc
// 不能把弹窗关掉，否则已填写的内容白输入。这里静态扫描源码，防止以后新加弹窗又带上。
// 侧边栏移动端抽屉、下拉菜单这类非表单浮层不受此限制（它们不调用 onClose 关闭整个窗体）。
const SOURCES = import.meta.glob(['../**/*.tsx', '!../test/**', '!../**/*.test.*'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>

const BACKDROP_CLOSE = /e\.target === e\.currentTarget[^\n]*onClose\(\)/
const ESCAPE_CLOSE = /key === 'Escape'[^\n]*onClose\(\)/

describe('弹窗只能用按钮关闭', () => {
  it('没有点遮罩关闭的弹窗', () => {
    const hits = Object.entries(SOURCES).filter(([, text]) => BACKDROP_CLOSE.test(text)).map(([p]) => p)
    expect(hits).toEqual([])
  })
  it('没有按 Esc 关闭的弹窗', () => {
    const hits = Object.entries(SOURCES).filter(([, text]) => ESCAPE_CLOSE.test(text)).map(([p]) => p)
    expect(hits).toEqual([])
  })
})

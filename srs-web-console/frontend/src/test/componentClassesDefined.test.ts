import { describe, expect, it } from 'vitest'

// 全局组件样式类（globals.css 的 @layer components）必须先定义再使用：
// 未定义的类名不会报错，只会让按钮显示成普通文字（2026-10-08 远程协助「确认关闭」、
// 网络管理对话框的确定/取消就是这样，用户以为点了没反应）。
const SOURCES = import.meta.glob(['../**/*.tsx', '!../test/**', '!../**/*.test.*'], {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>
// 测试配置 css: false 会把 CSS 导入替换成空串，样式表只能直接从磁盘读
async function readGlobalsCss(): Promise<string> {
  // jsdom 环境下 import.meta.url 不是文件路径；测试在前端目录下运行，按工作目录定位
  const fs = await import(/* @vite-ignore */ 'node:' + 'fs') as { readFileSync(p: string, enc: string): string }
  const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd()
  return fs.readFileSync(`${cwd}/src/styles/globals.css`, 'utf8')
}

// 只看 className 里的类名（btn-fullscreen 这类 data-testid 不算）
const CLASS_ATTR = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g
const COMPONENT_CLASS = /(?<![\w-])(btn-[a-z]+)(?![\w-])/g

describe('全局组件样式类', () => {
  it('源码里用到的 btn-* 都在全局样式里有定义', async () => {
    const css = await readGlobalsCss()
    expect(css).toContain('@layer components')
    const used = new Map<string, string>()
    for (const [path, text] of Object.entries(SOURCES)) {
      for (const attr of text.matchAll(CLASS_ATTR)) {
        for (const m of (attr[1] ?? attr[2] ?? attr[3] ?? '').matchAll(COMPONENT_CLASS)) used.set(m[1]!, path)
      }
    }
    expect(used.size).toBeGreaterThan(0)
    const missing = [...used].filter(([cls]) => !new RegExp(`\\.${cls}\\b`).test(css))
      .map(([cls, path]) => `${cls}（${path}）`)
    expect(missing).toEqual([])
  })
})

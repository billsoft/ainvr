import '@testing-library/jest-dom/vitest'

// jsdom 不实现 IntersectionObserver（浏览器专有 API），识别历史相关组件
// （AuthImage 懒加载、RecognitionHistoryDetail 无限滚动哨兵）此前从未被
// 渲染测试覆盖过，第一次测试就会因为这个全局缺失直接 ReferenceError。
// 默认让 observe() 立即视为"已进入视口"——大多数用例想看到懒加载完成后
// 的状态，不是占位态；个别用例需要测试"未进视口"分支时自行在用例内覆盖
// globalThis.IntersectionObserver。
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null
  readonly rootMargin: string = ''
  readonly scrollMargin: string = ''
  readonly thresholds: ReadonlyArray<number> = []
  private callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this,
    )
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver

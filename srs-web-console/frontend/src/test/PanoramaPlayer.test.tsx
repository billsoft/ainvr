import { render, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { VideoPlayer } from '@/components/player/VideoPlayer'
import flvjs from 'flv.js'

vi.mock('flv.js', () => ({ default: {
  isSupported: () => true, Events: { ERROR: 'error' },
  createPlayer: vi.fn(() => ({ on: vi.fn(), off: vi.fn(), attachMediaElement: vi.fn(), load: vi.fn(), destroy: vi.fn(), pause: vi.fn() })),
} }))
vi.mock('@/components/player/PanoramaView', () => ({ PanoramaView: ({ video, onError }: { video: HTMLVideoElement; onError: (s: string) => void }) =>
  <button data-testid="pano" data-video={video.tagName} onClick={() => onError('全景不可用')}>模拟GPU故障</button>,
}))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const props = { title: 'test', protocols: ['flv'] as ['flv'], primary: 'flv' as const, stream: { host: 'localhost', app: 'live', stream: 'test' } }
it('switching panorama reuses the same video and connection without bubbling to the tile', () => {
  const click = vi.fn()
  const { container } = render(<div onClick={click}><VideoPlayer {...props} allowPanorama /></div>)
  const video = container.querySelector('video')
  for (let i = 0; i < 3; i++) {
    fireEvent.click(screen.getByRole('button', { name: '开启360°观看' }))
    expect(screen.getByTestId('pano')).toHaveAttribute('data-video', 'VIDEO')
    fireEvent.click(screen.getByRole('button', { name: '关闭360°观看' }))
    expect(container.querySelectorAll('video')).toHaveLength(1)
    expect(container.querySelector('video')).toBe(video)
  }
  expect(flvjs.createPlayer).toHaveBeenCalledTimes(1)
  expect(click).not.toHaveBeenCalled()
})
it('renderer failure returns to flat without reconnecting', () => {
  render(<VideoPlayer {...props} allowPanorama />)
  fireEvent.click(screen.getByRole('button', { name: '开启360°观看' }))
  fireEvent.click(screen.getByTestId('pano'))
  expect(screen.queryByTestId('pano')).toBeNull()
  expect(screen.getByText('全景不可用')).toBeInTheDocument()
  expect(flvjs.createPlayer).toHaveBeenCalledTimes(1)
})
it('other player surfaces do not opt into panorama', () => {
  render(<VideoPlayer {...props} />)
  expect(screen.queryByRole('button', { name: '开启360°观看' })).toBeNull()
})

it('fullscreen toggles for flat and panorama, keeps controls visible and preserves the video', async () => {
  let active: Element | null = null
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active })
  const request = vi.fn(function(this: HTMLElement) {
    active = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve()
  })
  const exit = vi.fn(() => { active = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve() })
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  const { container } = render(<VideoPlayer {...props} allowPanorama />)
  const video = container.querySelector('video')
  try {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏' })))
    expect(active).toBe(screen.getByTestId('video-player'))
    expect(screen.getByTestId('player-toolbar')).toHaveClass('z-40', 'opacity-100')
    fireEvent.click(screen.getByRole('button', { name: '开启360°观看' }))
    expect(screen.getByTestId('pano')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '退出全屏' })))
    expect(exit).toHaveBeenCalledOnce()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏' })))
    fireEvent.click(screen.getByRole('button', { name: '关闭360°观看' }))
    expect(screen.queryByTestId('pano')).toBeNull()
    expect(active).toBe(screen.getByTestId('video-player'))
    expect(container.querySelector('video')).toBe(video)
    expect(flvjs.createPlayer).toHaveBeenCalledOnce()
    act(() => { active = null; document.dispatchEvent(new Event('fullscreenchange')) })
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument()
  } finally {
    delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen
    delete (document as Partial<Document>).exitFullscreen
    Reflect.deleteProperty(document, 'fullscreenElement')
  }
})

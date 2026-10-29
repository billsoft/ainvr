import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SearchEvidenceImage } from '@/pages/Search/SearchEvidenceImage'

vi.mock('@/components/common/AuthImage', () => ({ AuthImage: ({ alt, onImageLoaded }: { alt: string; onImageLoaded: () => void }) => <img alt={alt} onLoad={onImageLoaded} /> }))
afterEach(() => vi.restoreAllMocks())
it('maps each saved-image box through portrait letterboxing and removes it when the frame has no box', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON() {} })
  const view = render(<SearchEvidenceImage path="/first" alt="first" className="aspect-video" bbox={[0.2, 0.25, 0.5, 0.5]} />)
  const image = screen.getByRole('img')
  Object.defineProperties(image, { naturalWidth: { value: 200 }, naturalHeight: { value: 400 } })
  fireEvent.load(image)
  expect(screen.getByLabelText('检测目标位置')).toHaveStyle({ left: '170px', top: '50px', width: '50px', height: '100px' })
  view.rerender(<SearchEvidenceImage path="/second" alt="second" className="aspect-video" />)
  expect(screen.queryByLabelText('检测目标位置')).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

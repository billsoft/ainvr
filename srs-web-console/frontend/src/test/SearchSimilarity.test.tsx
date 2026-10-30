import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SearchSimilarity } from '@/pages/Search/SearchResults'
afterEach(cleanup)
it('shows signed cosine without a percent or a confidence claim', () => {
  const { rerender } = render(<SearchSimilarity value={0.13} />)
  expect(screen.getByText('相似度 0.1300')).toBeInTheDocument()
  rerender(<SearchSimilarity value={-0.08} />)
  expect(screen.getByText('相似度 -0.0800')).toBeInTheDocument()
})
it('does not fabricate a score for old or malformed results', () => {
  const { rerender } = render(<SearchSimilarity />)
  expect(screen.getByText('相似度暂不可用')).toBeInTheDocument()
  rerender(<SearchSimilarity value={Number.NaN} />)
  expect(screen.getByText('相似度暂不可用')).toBeInTheDocument()
})

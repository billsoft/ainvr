import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { expect, it } from 'vitest'
import { SmartSearchRedirect } from '@/pages/Search/SmartSearchRedirect'
import { searchInPlaybackHref } from '@/features/searchNavigation'

const id = '18b37191-9d09-481c-862f-51093bf87f4d'
function Here() { const l = useLocation(); return <output data-testid="at">{l.pathname + l.search}</output> }
const go = (entry: string) => render(<MemoryRouter initialEntries={[entry]}><Routes>
  <Route path="/smart-search" element={<SmartSearchRedirect />} /><Route path="*" element={<Here />} /></Routes></MemoryRouter>)

it('the old smart-search address opens the search beside the recording player, keeping channel and time', () => {
  go(`/smart-search?channel=${id}&from=1793062800000&to=1793062860000`)
  expect(screen.getByTestId('at')).toHaveTextContent(`/playback/${id}?from=1793062800000&to=1793062860000&search=1`)
})
it('without a usable scope it still opens the player with the search panel shown', () => {
  go('/smart-search')
  expect(screen.getByTestId('at')).toHaveTextContent('/playback?search=1')
})
it('builds the playback link only for a valid channel and window', () => {
  expect(searchInPlaybackHref(id, 1000, 61000)).toBe(`/playback/${id}?from=1000&to=61000&search=1`)
  expect(searchInPlaybackHref('not-a-uuid', 1000, 61000)).toBeNull()
})

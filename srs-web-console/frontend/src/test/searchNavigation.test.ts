import { expect, it } from 'vitest'
import { searchEntryScope, smartSearchHref } from '@/features/searchNavigation'

it('inherits only an explicit valid output identity and a bounded, valid interval', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const href = smartSearchHref(id, 1000, 61000)!
  expect(searchEntryScope(new URLSearchParams(href.split('?')[1]))).toEqual({ channel_ids: [id], from: '1970-01-01T00:00:01.000Z', to: '1970-01-01T00:01:01.000Z' })
  for (const [channel, from, to] of [[id, -1, 1000], [id, 100, 99], [id, 0, 32 * 86400000], ['input/path', 0, 1000], [null, 0, 1000]] as const)
    expect(smartSearchHref(channel, from, to)).toBeNull()
  expect(searchEntryScope(new URLSearchParams(`channel=${id}&from=bad&to=1000`))).toBeNull()
})

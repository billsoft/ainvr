import { expect, it, vi } from 'vitest'
import { flowService } from '@/api/flowService'
import { request } from '@/api/httpClient'
vi.mock('@/api/httpClient', () => ({ request: vi.fn() }))
it('leaves the default counter list unchanged and opts Analytics into historical bindings explicitly', async () => {
  vi.mocked(request).mockResolvedValue({ items: [] })
  await flowService.list()
  expect(request).toHaveBeenLastCalledWith('/flow/counters', expect.any(Object))
  await flowService.list({ includeInactiveBindings: true })
  expect(request).toHaveBeenLastCalledWith('/flow/counters?include_inactive=1', expect.any(Object))
})

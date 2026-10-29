import { afterEach, expect, it, vi } from 'vitest'
import { newOperationId } from '@/utils/operationId'
import { newAlarmOperationId } from '@/api/alarmZoneService'

afterEach(() => { vi.unstubAllGlobals() })

function randomBytes(values = Array.from({ length: 16 }, (_, index) => index)) {
  const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.set(values); return bytes })
  vi.stubGlobal('crypto', { getRandomValues })
  return getRandomValues
}

it('preserves the default 32 lowercase hex token and alarm alias', () => {
  const random = randomBytes()
  expect(newOperationId()).toBe('000102030405060708090a0b0c0d0e0f')
  expect(newOperationId('token')).toBe('000102030405060708090a0b0c0d0e0f')
  expect(newAlarmOperationId()).toBe('000102030405060708090a0b0c0d0e0f')
  expect(random).toHaveBeenCalledTimes(3)
  expect(random.mock.calls.every(([bytes]) => bytes.length === 16)).toBe(true)
})

it('creates an RFC 4122 version 4 UUID without needing randomUUID', () => {
  randomBytes()
  expect(newOperationId('uuid')).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  randomBytes(Array(16).fill(255))
  expect(newOperationId('uuid')).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
})

it.each([undefined, {}, { randomUUID: () => 'unsafe-substitute' }, {
  getRandomValues: () => { throw new Error('random source unavailable') },
}])('rejects an unavailable secure random source without Math.random fallback', crypto => {
  vi.stubGlobal('crypto', crypto)
  const random = vi.spyOn(Math, 'random')
  try {
    expect(() => newOperationId()).toThrow('当前浏览器无法生成安全请求标识')
    expect(() => newOperationId('uuid')).toThrow('当前浏览器无法生成安全请求标识')
    expect(random).not.toHaveBeenCalled()
  } finally { random.mockRestore() }
})

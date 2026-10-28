import { describe, test, expect } from 'bun:test'
import { formatDateToUTC, resolveDelayToDate, utcNow } from '../../src/utils/date.js'

describe('date', () => {
  describe('utcNow', () => {
    test('returns timestamp in milliseconds close to Date.now()', () => {
      const before = Date.now()
      const result = utcNow()
      const after = Date.now()

      expect(result).toBeGreaterThanOrEqual(before - 10)
      expect(result).toBeLessThanOrEqual(after + 10)
    })
  })

  describe('formatDateToUTC', () => {
    test('formats ISO string to UTC string YYYY-MM-DDTHH:mm:ss', () => {
      const date = '2025-06-15T10:30:45.123Z'
      expect(formatDateToUTC(date)).toBe('2025-06-15T10:30:45')
    })

    test('does not shift the time when the string already represents a UTC time without explicit timezone', () => {
      const date = '2025-06-15T10:30:45'
      expect(formatDateToUTC(date)).toBe('2025-06-15T10:30:45')
    })
  })

  describe('resolveDelayToDate', () => {
    test('30 minute delay returns ISO string ~30min in the future', () => {
      const before = Date.now()
      const result = resolveDelayToDate({ value: 30, unit: 'minutes' })
      const after = Date.now()

      const resultMs = new Date(result).getTime()
      const expectedMin = before + 30 * 60_000
      const expectedMax = after + 30 * 60_000

      expect(resultMs).toBeGreaterThanOrEqual(expectedMin - 100)
      expect(resultMs).toBeLessThanOrEqual(expectedMax + 100)
    })

    test('2 hour delay returns ISO string ~2h in the future', () => {
      const before = Date.now()
      const result = resolveDelayToDate({ value: 2, unit: 'hours' })
      const after = Date.now()

      const resultMs = new Date(result).getTime()
      const expectedMin = before + 2 * 3_600_000
      const expectedMax = after + 2 * 3_600_000

      expect(resultMs).toBeGreaterThanOrEqual(expectedMin - 100)
      expect(resultMs).toBeLessThanOrEqual(expectedMax + 100)
    })
  })
})

import { describe, test, expect } from 'bun:test'
import { isExpired, isOnce, isRecurring } from '../../src/utils/schedule.js'

describe('schedule', () => {
  describe('schedule type helpers', () => {
    test('delay and at return once', () => {
      expect(isOnce({ delay: { value: 5, unit: 'minutes' } })).toBe(true)
      expect(isOnce({ at: new Date().toISOString() })).toBe(true)
      expect(isRecurring({ delay: { value: 5, unit: 'minutes' } })).toBe(false)
      expect(isRecurring({ at: new Date().toISOString() })).toBe(false)
    })

    test('cron and rate return recurring', () => {
      expect(isRecurring({ cron: '0 12 * * ? *' })).toBe(true)
      expect(isRecurring({ rate: { value: 1, unit: 'hours' } })).toBe(true)
      expect(isOnce({ cron: '0 12 * * ? *' })).toBe(false)
      expect(isOnce({ rate: { value: 1, unit: 'hours' } })).toBe(false)
    })
  })

  describe('isExpired', () => {
    test('schedule without endDate returns false', () => {
      expect(isExpired({ cron: '0 12 * * ? *' })).toBe(false)
    })

    test('schedule with endDate in the future returns false', () => {
      const futureDate = new Date(Date.now() + 86_400_000).toISOString()
      expect(isExpired({ rate: { value: 1, unit: 'hours' }, endDate: futureDate })).toBe(false)
    })

    test('schedule with endDate in the past returns true', () => {
      const pastDate = new Date(Date.now() - 86_400_000).toISOString()
      expect(isExpired({ rate: { value: 1, unit: 'hours' }, endDate: pastDate })).toBe(true)
    })
  })
})

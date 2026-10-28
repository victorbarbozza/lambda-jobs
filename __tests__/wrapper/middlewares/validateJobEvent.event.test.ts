import { describe, test, expect } from 'bun:test'
import middy from '@middy/core'
import { validateJobEventMiddleware } from '../../../src/wrapper/middlewares/validateJobEvent.js'

const validEvent = {
  id: 'abc-123',
  name: 'sendEmail',
  jobSource: 'api',
  payload: { to: 'a@b.com' },
  scheduledTime: '2025-01-01T00:00:00',
  attempt: 1,
  maxRetryAttempts: 3,
}

const invoke = (event: unknown) => {
  const handler = middy(async (e: unknown) => e).use(validateJobEventMiddleware())
  return handler(event as never, {} as never)
}

describe('validateJobEvent — event schema', () => {
  test('complete and valid event passes', async () => {
    const result = await invoke(validEvent)
    expect(result).toEqual(validEvent)
  })

  test('missing required field: error', async () => {
    const { id, ...missing } = validEvent
    await expect(invoke(missing)).rejects.toThrow()
  })

  test('attempt: 0 → error (minimum: 1)', async () => {
    await expect(invoke({ ...validEvent, attempt: 0 })).rejects.toThrow()
  })

  test('maxRetryAttempts: -1 → error (minimum: 0)', async () => {
    await expect(invoke({ ...validEvent, maxRetryAttempts: -1 })).rejects.toThrow()
  })

  test('extra field → error (additionalProperties: false)', async () => {
    await expect(invoke({ ...validEvent, extra: 'nope' })).rejects.toThrow()
  })
})

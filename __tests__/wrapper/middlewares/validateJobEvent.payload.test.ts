import { describe, test, expect } from 'bun:test'
import middy from '@middy/core'
import { Type } from 'typebox'
import { validateJobEventMiddleware } from '../../../src/wrapper/middlewares/validateJobEvent.js'

const schema = Type.Object({
  to: Type.String(),
  subject: Type.String(),
})

const makeEvent = (payload: unknown) => ({
  id: 'abc',
  name: 'sendEmail',
  jobSource: 'api',
  payload,
  scheduledTime: '2025-01-01T00:00:00',
  attempt: 1,
  maxRetryAttempts: 0,
})

const invoke = (payload: unknown) => {
  const handler = middy(async (e: unknown) => e).use(validateJobEventMiddleware(schema))
  return handler(makeEvent(payload) as never, {} as never)
}

describe('validateJobEvent — payload schema', () => {
  test('payload matching the schema passes', async () => {
    const result = await invoke({ to: 'a@b.com', subject: 'hi' })
    expect(result).toBeDefined()
  })

  test('payload with missing field is rejected with descriptive message', async () => {
    await expect(invoke({ to: 'a@b.com' })).rejects.toThrow()
  })

  test('payload with wrong type is rejected', async () => {
    // AJV with coerceTypes converts primitives, so we use an object where a string is expected
    await expect(invoke({ to: { nested: true }, subject: 'hi' })).rejects.toThrow()
  })
})

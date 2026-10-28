import { describe, expect, test } from 'bun:test'
import { getScope, runInScope, type JobScope } from '../../src/utils/scope.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe('scope', () => {
  test('outside runInScope: empty scope', () => {
    expect(getScope()).toEqual({})
  })

  test('runInScope exposes the scope to fn and returns its result', () => {
    const scope: JobScope = { config: { tableName: 'table-a' }, jobName: 'sendEmail' }

    const result = runInScope(scope, () => getScope())

    expect(result).toBe(scope)
  })

  test('the scope survives awaits inside fn', async () => {
    const result = await runInScope({ jobName: 'sendEmail' }, async () => {
      await tick()
      return getScope().jobName
    })

    expect(result).toBe('sendEmail')
  })

  test('after runInScope ends: empty scope again', async () => {
    await runInScope({ jobName: 'sendEmail' }, async () => {
      await tick()
    })

    expect(getScope()).toEqual({})
  })

  test('nested scope replaces the outer one until it ends', () => {
    const seen = runInScope({ jobName: 'outer' }, () => {
      const inner = runInScope({ jobName: 'inner' }, () => getScope().jobName)
      return [inner, getScope().jobName]
    })

    expect(seen).toEqual(['inner', 'outer'])
  })

  test('concurrent scopes do not mix', async () => {
    const read = (jobName: string, delay: number) =>
      runInScope({ jobName }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay))
        return getScope().jobName
      })

    const result = await Promise.all([read('a', 5), read('b', 1), read('c', 3)])

    expect(result).toEqual(['a', 'b', 'c'])
  })

  test('errors thrown by fn propagate', async () => {
    await expect(
      runInScope({}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
  })
})

import { afterAll, beforeEach, describe, expect, spyOn, test, vi } from 'bun:test'
import { sendNotification } from '../../src/connectors/notification.js'
import type { JobAlert } from '../../src/types/alert.js'
import { runInScope } from '../../src/utils/scope.js'

const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

const alert: JobAlert = { type: 'custom', message: 'stop everything' }

describe('sendNotification', () => {
  beforeEach(() => {
    warnSpy.mockClear()
    errorSpy.mockClear()
  })

  afterAll(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  test('with onAlert in the scope: delivers the alert to it', async () => {
    const onAlert = vi.fn()

    await runInScope({ onAlert }, () => sendNotification(alert))

    expect(onAlert).toHaveBeenCalledTimes(1)
    expect(onAlert).toHaveBeenCalledWith(alert)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('with an async onAlert: waits for it', async () => {
    let delivered = false
    const onAlert = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered = true
    }

    await runInScope({ onAlert }, () => sendNotification(alert))

    expect(delivered).toBe(true)
  })

  test('without onAlert: logs the alert as JSON with console.warn', async () => {
    await runInScope({}, () => sendNotification(alert))

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const line = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(line).toEqual({
      level: 'warn',
      message: '[jobs-notification] onAlert not set, alert logged only',
      alert: 'custom',
      text: 'stop everything',
    })
  })

  test('without onAlert: the text is the formatted alert', async () => {
    await runInScope({}, () =>
      sendNotification({
        type: 'internal_error',
        stage: 'startExecution',
        error: new Error('throttled'),
      })
    )

    const line = JSON.parse(warnSpy.mock.calls[0]![0] as string)
    expect(line.alert).toBe('internal_error')
    expect(line.text).toBe('startExecution\nthrottled')
  })

  test('outside any scope: logs and does not fail', async () => {
    await expect(sendNotification(alert)).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  test('onAlert throws: logs the error and does not rethrow', async () => {
    const failure = new Error('webhook down')
    const onAlert = vi.fn(async () => {
      throw failure
    })

    await expect(
      runInScope({ onAlert }, () => sendNotification(alert))
    ).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledWith(
      '[jobs-notification] Failed to send alert:',
      failure
    )
  })

  test('concurrent scopes do not mix', async () => {
    const first = vi.fn()
    const second = vi.fn()

    await Promise.all([
      runInScope({ onAlert: first }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        await sendNotification({ type: 'custom', message: 'first' })
      }),
      runInScope({ onAlert: second }, () =>
        sendNotification({ type: 'custom', message: 'second' })
      ),
    ])

    expect(first).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith({ type: 'custom', message: 'first' })
    expect(second).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ type: 'custom', message: 'second' })
  })
})

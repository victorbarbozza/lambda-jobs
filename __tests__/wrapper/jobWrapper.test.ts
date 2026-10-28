import { beforeEach, describe, expect, mock, spyOn, test, vi } from 'bun:test'
import type { Context, Handler } from 'aws-lambda'
import type { JobEvent } from '../../src/types/event.js'
import { JobSkippedError, JobTerminalStateError } from '../../src/utils/errors.js'
import { applyJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'

// --- Mocks ---

const mockLifecycle = {
  startExecution: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue(undefined),
  failExecution: vi.fn(),
  finishJob: vi.fn().mockResolvedValue(undefined),
}

const mockSendNotification = vi.fn().mockResolvedValue(undefined)

applyJobsTestEnv()

const lifecycle = await import('../../src/service/lifecycle/index.js')
const notification = await import('../../src/connectors/notification.js')
const { jobWrapper } = await import('../../src/wrapper/jobWrapper.js')

const startExecutionSpy = spyOn(lifecycle, 'startExecution').mockImplementation(
  (...args) => mockLifecycle.startExecution(...args)
)
const completeExecutionSpy = spyOn(lifecycle, 'completeExecution').mockImplementation(
  (...args) => mockLifecycle.completeExecution(...args)
)
const failExecutionSpy = spyOn(lifecycle, 'failExecution').mockImplementation(
  (...args) => mockLifecycle.failExecution(...args)
)
const finishJobSpy = spyOn(lifecycle, 'finishJob').mockImplementation((...args) =>
  mockLifecycle.finishJob(...args)
)
const sendNotificationSpy = spyOn(notification, 'sendNotification').mockImplementation(
  (...args) => mockSendNotification(...args)
)

// --- Helpers ---

const makeEvent = (overrides: Partial<JobEvent> = {}): JobEvent => ({
  id: 'job-1',
  name: 'sendEmail',
  jobSource: 'api',
  payload: { to: 'a@b.com' },
  scheduledTime: '2025-01-01T00:00:00',
  attempt: 1,
  maxRetryAttempts: 2,
  ...overrides,
})

const makeContext = (): Context =>
  ({
    functionName: 'test',
    callbackWaitsForEmptyEventLoop: false,
    functionVersion: '1',
    invokedFunctionArn: TEST_FUNCTION_ARN,
    memoryLimitInMB: '128',
    awsRequestId: 'req-1',
    logGroupName: 'lg',
    logStreamName: 'ls',
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
    getRemainingTimeInMillis: () => 60_000,
  }) as unknown as Context

const invokeWrapped = async <TEvent, TResult>(
  wrapped: Handler<TEvent, TResult>,
  event: TEvent,
  context: Context = makeContext()
): Promise<TResult> =>
  wrapped(event, context, vi.fn()) as Promise<TResult>

const makeExecutionContext = (
  overrides: Partial<{ attempt: number; alert: boolean; maxRetryAttempts: number }> = {}
) => ({
  execution: {
    scheduledTime: '2025-01-01T00:00:00',
    status: 'running' as const,
    attempt: 1,
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  },
  jobEntity: {
    id: 'job-1',
    name: 'sendEmail',
    jobSource: 'api',
    status: 'active' as const,
    schedule: { delay: { value: 1, unit: 'minutes' as const } },
    payload: {},
    maxRetryAttempts: overrides.maxRetryAttempts ?? 2,
    failureStrategy: { action: 'continue' as const, alert: overrides.alert ?? false },
    createdAt: new Date().toISOString(),
  },
  isNewExecution: true,
  attempt: overrides.attempt ?? 1,
  deadline: '2025-01-01T00:05:00.000Z',
})

describe('jobWrapper', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    startExecutionSpy.mockImplementation((...args) => mockLifecycle.startExecution(...args))
    completeExecutionSpy.mockImplementation((...args) =>
      mockLifecycle.completeExecution(...args)
    )
    failExecutionSpy.mockImplementation((...args) => mockLifecycle.failExecution(...args))
    finishJobSpy.mockImplementation((...args) => mockLifecycle.finishJob(...args))
    mockLifecycle.finishJob.mockResolvedValue(undefined)
    sendNotificationSpy.mockImplementation((...args) => mockSendNotification(...args))
    mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext())
    mockLifecycle.completeExecution.mockResolvedValue(undefined)
    mockLifecycle.failExecution.mockResolvedValue({
      outcome: 'retry',
      runAt: new Date(Date.now() + 60_000).toISOString(),
    })
  })

  // ===========================
  // Middleware stack
  // ===========================

  describe('middleware stack', () => {
    test('invalid event throws an error before the handler', async () => {
      const handler = vi.fn()
      const wrapped = jobWrapper(handler)

      await expect(invokeWrapped(wrapped, {} as never, makeContext())).rejects.toThrow()
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe('terminal states', () => {
    test('startExecution with terminal state: returns silent success and does not call handler', async () => {
      mockLifecycle.startExecution.mockRejectedValue(
        new JobTerminalStateError('already closed', { reason: 'completed' })
      )

      const handler = vi.fn()
      const wrapped = jobWrapper(handler)

      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(result).toBeUndefined()
      expect(handler).not.toHaveBeenCalled()
      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    test('startExecution with terminal state: does not call onInternalError', async () => {
      mockLifecycle.startExecution.mockRejectedValue(
        new JobTerminalStateError('already closed', { reason: 'cancelled' })
      )

      const onInternalError = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onInternalError })

      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(result).toBeUndefined()
      expect(onInternalError).not.toHaveBeenCalled()
    })
  })

  // ===========================
  // Success flow
  // ===========================

  describe('success flow', () => {
    test('calls lifecycle.startExecution and then handler', async () => {
      const order: string[] = []
      mockLifecycle.startExecution.mockImplementation(async () => {
        order.push('start')
        return makeExecutionContext()
      })

      const handler = vi.fn(async () => {
        order.push('handler')
        return 'ok'
      })

      const wrapped = jobWrapper(handler)
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(order).toEqual(['start', 'handler'])
    })

    test('overwrites event.attempt with value from the lifecycle', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ attempt: 5 }))

      let capturedAttempt: number | undefined
      const handler = vi.fn(async (e: JobEvent) => {
        capturedAttempt = e.attempt
        return 'ok'
      })

      const wrapped = jobWrapper(handler)
      await invokeWrapped(wrapped, makeEvent({ attempt: 1 }), makeContext())

      expect(capturedAttempt).toBe(5)
    })

    test('calls lifecycle.completeExecution after handler', async () => {
      const handler = vi.fn(async () => 'done')
      const wrapped = jobWrapper(handler)

      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockLifecycle.completeExecution).toHaveBeenCalledTimes(1)
    })

    test('returns handler result', async () => {
      const wrapped = jobWrapper(async () => ({ sent: true }))
      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())
      expect(result).toEqual({ sent: true })
    })

    test('onSuccess receives (event, result, duration)', async () => {
      const onSuccess = vi.fn()
      const wrapped = jobWrapper(async () => 'result', { onSuccess })

      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        'result',
        expect.any(Number)
      )
    })
  })

  // ===========================
  // Retry flow
  // ===========================

  describe('retry flow', () => {
    test('attempt > 1: calls onRetry(event) before the handler', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ attempt: 3 }))

      const onRetry = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onRetry })

      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onRetry).toHaveBeenCalledTimes(1)
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }))
    })

    test('attempt === 1: does NOT call onRetry', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ attempt: 1 }))

      const onRetry = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onRetry })

      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onRetry).not.toHaveBeenCalled()
    })
  })

  describe('error flow', () => {
    const handlerError = new Error('handler blew up')

    test('does not rethrow the handler error', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const wrapped = jobWrapper(async () => { throw handlerError })

      await expect(
        invokeWrapped(wrapped, makeEvent(), makeContext())
      ).resolves.toBeUndefined()
    })

    test('calls failExecution with the error and the context', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const wrapped = jobWrapper(async () => { throw handlerError })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockLifecycle.failExecution).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        handlerError,
        expect.anything(),
        undefined,
        { retryInSeconds: undefined, giveUp: false }
      )
    })

    test('retry: does NOT call onJobFailure', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const onJobFailure = vi.fn()
      const wrapped = jobWrapper(async () => { throw handlerError }, { onJobFailure })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onJobFailure).not.toHaveBeenCalled()
    })

    test('retry: calls onExecutionError', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const onExecutionError = vi.fn()
      const wrapped = jobWrapper(async () => { throw handlerError }, { onExecutionError })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onExecutionError).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        handlerError,
        expect.any(Number)
      )
    })

    test('exhausted + alert true: notifies', async () => {
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors: [] })
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ alert: true }))

      const wrapped = jobWrapper(async () => { throw handlerError })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockSendNotification).toHaveBeenCalled()
    })

    test('exhausted + alert false: does not notify', async () => {
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors: [] })
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ alert: false }))

      const wrapped = jobWrapper(async () => { throw handlerError })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    test('exhausted: calls onJobFailure with the failures of the occurrence', async () => {
      const errors = [
        { jobId: 'job-1', attempt: 1, message: 'failed', scheduledTime: 'x' },
      ]
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors })

      const onJobFailure = vi.fn()
      const wrapped = jobWrapper(async () => { throw handlerError }, { onJobFailure })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onJobFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        errors,
        expect.any(Function)
      )
    })

    test('the alert handed to onJobFailure really sends a notification', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'exhausted',
        errors: [],
      })

      // Without invoking the helper, the tests only assert that "a function arrived" — it
      // could be broken without any test noticing.
      const wrapped = jobWrapper(async () => { throw handlerError }, {
        onJobFailure: (_job, _errors, alert) => alert('stop everything'),
      })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockSendNotification).toHaveBeenCalledWith({
        type: 'custom',
        message: 'stop everything',
      })
    })
  })

  describe('control context', () => {
    test('ctx.done ends the job without going through the recurrence', async () => {
      const wrapped = jobWrapper(async (_job, ctx) => ctx.done())
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockLifecycle.finishJob).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ deadline: '2025-01-01T00:05:00.000Z' })
      )
      expect(mockLifecycle.completeExecution).not.toHaveBeenCalled()
    })

    test('ctx.giveUp tells the lifecycle not to schedule a new attempt', async () => {
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors: [] })

      const onJobFailure = vi.fn()
      const wrapped = jobWrapper(
        async (_job, ctx) => ctx.giveUp('no use insisting'),
        { onJobFailure }
      )
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      // Without this signal the lifecycle sees just one more failure and schedules the
      // next attempt, spending the whole `maxRetryAttempts` of a job that already gave up.
      expect(mockLifecycle.failExecution).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Error),
        expect.anything(),
        undefined,
        expect.objectContaining({ giveUp: true })
      )
      expect(onJobFailure).toHaveBeenCalled()
    })

    test('regular failure does not set giveUp', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const wrapped = jobWrapper(async () => { throw new Error('failed') })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockLifecycle.failExecution).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Error),
        expect.anything(),
        undefined,
        expect.objectContaining({ giveUp: false })
      )
    })

    test('ctx.retryIn sets the wait for the next attempt', async () => {
      mockLifecycle.failExecution.mockResolvedValue({
        outcome: 'retry',
        runAt: new Date().toISOString(),
      })

      const wrapped = jobWrapper(async (_job, ctx) => {
        ctx.retryIn(90)
        throw new Error('failed')
      })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(mockLifecycle.failExecution).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Error),
        expect.anything(),
        undefined,
        expect.objectContaining({ retryInSeconds: 90 })
      )
    })

    test('ctx.isLastAttempt reflects the attempt limit', async () => {
      let seen: boolean | undefined
      const wrapped = jobWrapper(async (_job, ctx) => {
        seen = ctx.isLastAttempt
      })

      mockLifecycle.startExecution.mockResolvedValue(
        makeExecutionContext({ attempt: 1, maxRetryAttempts: 0 })
      )

      await invokeWrapped(wrapped, makeEvent({ maxRetryAttempts: 0 }), makeContext())

      expect(seen).toBe(true)
    })
  })

  describe('handleInfraError', () => {
    test('NON-JobSkippedError error: calls sendNotification', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new Error('infra fail'))

      const wrapped = jobWrapper(async () => 'ok')
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow('infra fail')

      expect(mockSendNotification).toHaveBeenCalled()
    })

    test('JobSkippedError error: does NOT call sendNotification', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new JobSkippedError('skipped'))

      const wrapped = jobWrapper(async () => 'ok')
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow(JobSkippedError)

      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    test('startExecution fails: notifies and rethrows', async () => {
      const infraErr = new Error('start fail')
      mockLifecycle.startExecution.mockRejectedValue(infraErr)

      const wrapped = jobWrapper(async () => 'ok')
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow(infraErr)

      expect(mockSendNotification).toHaveBeenCalled()
    })

    test('completeExecution fails: handler still returns result', async () => {
      mockLifecycle.completeExecution.mockRejectedValue(new Error('complete fail'))

      const wrapped = jobWrapper(async () => ({ sent: true }))
      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(result).toEqual({ sent: true })
      expect(mockSendNotification).toHaveBeenCalled()
    })

    test('failExecution throws → handleInfraError notifies, onJobFailure is NOT called, onExecutionError is still called', async () => {
      mockLifecycle.failExecution.mockRejectedValue(new Error('fail exec error'))

      const onJobFailure = vi.fn()
      const onExecutionError = vi.fn()

      const wrapped = jobWrapper(
        async () => { throw new Error('handler err') },
        { onJobFailure, onExecutionError }
      )

      await expect(
        invokeWrapped(wrapped, makeEvent(), makeContext())
      ).resolves.toBeUndefined()

      expect(mockSendNotification).toHaveBeenCalled()
      expect(onJobFailure).not.toHaveBeenCalled()
      expect(onExecutionError).toHaveBeenCalled()
    })

    test('onInternalError receives the stage, the error and the alert', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new Error('start fail'))

      const onInternalError = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onInternalError })

      await expect(
        invokeWrapped(wrapped, makeEvent(), makeContext())
      ).rejects.toThrow('start fail')

      expect(onInternalError).toHaveBeenCalledWith(
        'startExecution',
        expect.objectContaining({ message: 'start fail' }),
        expect.any(Function)
      )
    })

    test('giveUp with broken failExecution still announces the terminal failure', async () => {
      mockLifecycle.failExecution.mockRejectedValue(new Error('fail exec error'))

      const onJobFailure = vi.fn()
      const wrapped = jobWrapper(
        async (_job, ctx) => ctx.giveUp('no use'),
        { onJobFailure }
      )
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      // Whoever gave up will not retry anyway: even without knowing what the
      // lifecycle recorded, the terminal failure has to be announced.
      expect(onJobFailure).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'job-1' }),
        [],
        expect.any(Function)
      )
    })

    test('onInternalError callback throws → error does NOT propagate (console.error only)', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new Error('infra'))

      const onInternalError = vi.fn(() => { throw new Error('callback boom') })
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const wrapped = jobWrapper(async () => 'ok', { onInternalError })
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow('infra')

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // ===========================
  // safeCallback
  // ===========================

  describe('safeCallback', () => {
    test('callback that throws an error: error does NOT propagate to the main flow', async () => {
      const onSuccess = vi.fn(() => { throw new Error('callback error') })

      const wrapped = jobWrapper(async () => 'ok', { onSuccess })
      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(result).toBe('ok')
    })
  })

  // ===========================
  // eventSchema
  // ===========================

  describe('eventSchema', () => {
    test('invalid payload with eventSchema: throws JobValidationError before the handler', async () => {
      const { Type } = await import('typebox')
      const schema = Type.Object({ to: Type.String() })

      const handler = vi.fn()
      const wrapped = jobWrapper(handler, { eventSchema: schema })

      await expect(
        invokeWrapped(
          wrapped,
          makeEvent({ payload: { wrong: 123 } as never }),
          makeContext()
        )
      ).rejects.toThrow()

      expect(handler).not.toHaveBeenCalled()
    })

    test('valid payload with eventSchema: handler runs normally', async () => {
      const { Type } = await import('typebox')
      const schema = Type.Object({ to: Type.String() })

      const handler = vi.fn(async () => 'ok')
      const wrapped = jobWrapper(handler, { eventSchema: schema })

      const result = await invokeWrapped(
        wrapped,
        makeEvent({ payload: { to: 'a@b.com' } as never }),
        makeContext()
      )

      expect(result).toBe('ok')
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })
})

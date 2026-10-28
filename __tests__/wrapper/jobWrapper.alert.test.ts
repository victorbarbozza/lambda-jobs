import { beforeEach, describe, expect, mock, spyOn, test, vi } from 'bun:test'
import type { Context, Handler } from 'aws-lambda'
import type { JobEvent } from '../../src/types/event.js'
import { JobSkippedError } from '../../src/utils/errors.js'
import { applyJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'

// --- Mocks ---

const mockLifecycle = {
  startExecution: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue(undefined),
  failExecution: vi.fn(),
  finishJob: vi.fn().mockResolvedValue(undefined),
}

applyJobsTestEnv()

const lifecycle = await import('../../src/service/lifecycle/index.js')
const { jobWrapper } = await import('../../src/wrapper/jobWrapper.js')

// `sendNotification` is not mocked: the alerts go through it and reach `onAlert`.
spyOn(lifecycle, 'startExecution').mockImplementation((...args) =>
  mockLifecycle.startExecution(...args)
)
spyOn(lifecycle, 'completeExecution').mockImplementation((...args) =>
  mockLifecycle.completeExecution(...args)
)
spyOn(lifecycle, 'failExecution').mockImplementation((...args) =>
  mockLifecycle.failExecution(...args)
)
spyOn(lifecycle, 'finishJob').mockImplementation((...args) =>
  mockLifecycle.finishJob(...args)
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

const makeExecutionContext = (overrides: Partial<{ alert: boolean }> = {}) => ({
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
    maxRetryAttempts: 2,
    failureStrategy: { action: 'continue' as const, alert: overrides.alert ?? false },
    createdAt: new Date().toISOString(),
  },
  isNewExecution: true,
  attempt: 1,
  deadline: '2025-01-01T00:05:00.000Z',
})

const errors = [
  { jobId: 'job-1', attempt: 3, message: 'failed', scheduledTime: '2025-01-01T00:00:00' },
]

describe('jobWrapper onAlert', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext())
    mockLifecycle.completeExecution.mockResolvedValue(undefined)
    mockLifecycle.failExecution.mockResolvedValue({
      outcome: 'retry',
      runAt: new Date(Date.now() + 60_000).toISOString(),
    })
  })

  describe('job_failed', () => {
    test('exhausted + alert true: receives job_failed with the job and the errors', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ alert: true }))
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors })

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => { throw new Error('failed') }, { onAlert })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onAlert).toHaveBeenCalledTimes(1)
      expect(onAlert).toHaveBeenCalledWith({
        type: 'job_failed',
        job: expect.objectContaining({ id: 'job-1', name: 'sendEmail' }),
        errors,
      })
    })

    test('exhausted + alert false: does not receive job_failed', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ alert: false }))
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors })

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => { throw new Error('failed') }, { onAlert })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onAlert).not.toHaveBeenCalled()
    })

    test('retry + alert true: does not receive job_failed', async () => {
      mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext({ alert: true }))

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => { throw new Error('failed') }, { onAlert })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onAlert).not.toHaveBeenCalled()
    })
  })

  describe('internal_error', () => {
    test('receives internal_error with the stage and the error', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new Error('throttled'))

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onAlert })
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow(
        'throttled'
      )

      expect(onAlert).toHaveBeenCalledTimes(1)
      expect(onAlert).toHaveBeenCalledWith({
        type: 'internal_error',
        stage: 'startExecution',
        error: expect.objectContaining({ message: 'throttled' }),
      })
    })

    test('completeExecution fails: receives internal_error and the result does not change', async () => {
      mockLifecycle.completeExecution.mockRejectedValue(new Error('complete fail'))

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => ({ sent: true }), { onAlert })
      const result = await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(result).toEqual({ sent: true })
      expect(onAlert).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'internal_error', stage: 'completeExecution' })
      )
    })

    test('JobSkippedError: does not receive internal_error', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new JobSkippedError('skipped'))

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', { onAlert })
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow(
        JobSkippedError
      )

      expect(onAlert).not.toHaveBeenCalled()
    })
  })

  describe('custom', () => {
    test('the alert handed to onJobFailure arrives as custom', async () => {
      mockLifecycle.failExecution.mockResolvedValue({ outcome: 'exhausted', errors })

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => { throw new Error('failed') }, {
        onAlert,
        onJobFailure: (job, jobErrors, alert) =>
          alert(`${job.name} failed ${jobErrors.length} time(s)`),
      })
      await invokeWrapped(wrapped, makeEvent(), makeContext())

      expect(onAlert).toHaveBeenCalledTimes(1)
      expect(onAlert).toHaveBeenCalledWith({
        type: 'custom',
        message: 'sendEmail failed 1 time(s)',
      })
    })

    test('the alert handed to onInternalError arrives as custom', async () => {
      mockLifecycle.startExecution.mockRejectedValue(new Error('throttled'))

      const onAlert = vi.fn()
      const wrapped = jobWrapper(async () => 'ok', {
        onAlert,
        onInternalError: (stage, _error, alert) => alert(`check ${stage}`),
      })
      await expect(invokeWrapped(wrapped, makeEvent(), makeContext())).rejects.toThrow()

      expect(onAlert).toHaveBeenCalledTimes(2)
      expect(onAlert).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ type: 'internal_error' })
      )
      expect(onAlert).toHaveBeenNthCalledWith(2, {
        type: 'custom',
        message: 'check startExecution',
      })
    })
  })

  describe('scope', () => {
    test('two wrappers keep their own onAlert', async () => {
      mockLifecycle.startExecution.mockImplementation(async (event: JobEvent) => {
        if (event.id === 'job-1') await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error(`${event.id} throttled`)
      })

      const first = vi.fn()
      const second = vi.fn()
      const wrappedFirst = jobWrapper(async () => 'ok', { onAlert: first })
      const wrappedSecond = jobWrapper(async () => 'ok', { onAlert: second })

      await Promise.allSettled([
        invokeWrapped(wrappedFirst, makeEvent({ id: 'job-1' }), makeContext()),
        invokeWrapped(wrappedSecond, makeEvent({ id: 'job-2' }), makeContext()),
      ])

      expect(first).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'job-1 throttled' }),
        })
      )
      expect(second).toHaveBeenCalledTimes(1)
      expect(second).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: 'job-2 throttled' }),
        })
      )
    })
  })
})

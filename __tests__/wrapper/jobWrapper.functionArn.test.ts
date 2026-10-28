import { beforeEach, describe, expect, mock, spyOn, test, vi } from 'bun:test'
import type { Context, Handler } from 'aws-lambda'
import type { JobEvent } from '../../src/types/event.js'
import type { JobScope } from '../../src/utils/scope.js'
import { applyJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'

// --- Mocks ---

const sendMock = vi.fn().mockResolvedValue({})
const createCommandSpy = vi.fn()

mock.module('@aws-sdk/client-scheduler', () => ({
  SchedulerClient: class {
    send = sendMock
  },
  CreateScheduleCommand: class {
    constructor(input: unknown) {
      createCommandSpy(input)
    }
  },
  DeleteScheduleCommand: class {},
  ResourceNotFoundException: class extends Error {},
}))

const mockLifecycle = {
  startExecution: vi.fn(),
  completeExecution: vi.fn().mockResolvedValue(undefined),
  failExecution: vi.fn(),
  finishJob: vi.fn().mockResolvedValue(undefined),
}

applyJobsTestEnv()

const lifecycle = await import('../../src/service/lifecycle/index.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const { getScope } = await import('../../src/utils/scope.js')
const { jobWrapper } = await import('../../src/wrapper/jobWrapper.js')

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

const makeContext = (invokedFunctionArn: string = TEST_FUNCTION_ARN): Context =>
  ({
    functionName: 'test',
    callbackWaitsForEmptyEventLoop: false,
    functionVersion: '1',
    invokedFunctionArn,
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

const makeExecutionContext = () => ({
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
    failureStrategy: { action: 'continue' as const, alert: false },
    createdAt: new Date().toISOString(),
  },
  isNewExecution: true,
  attempt: 1,
  deadline: '2025-01-01T00:05:00.000Z',
})

/** `failExecution` that schedules the next attempt, as the real one does. */
const scheduleRetry = async (event: JobEvent) => {
  const runAt = new Date(Date.now() + 60_000).toISOString()

  await scheduler.createRetrySchedule({
    id: event.id,
    jobName: event.name,
    jobSource: event.jobSource,
    payload: {},
    maxRetryAttempts: event.maxRetryAttempts,
    scheduledTime: event.scheduledTime,
    runAt,
    attempt: event.attempt + 1,
  })

  return { outcome: 'retry', runAt }
}

const lastTarget = () =>
  (createCommandSpy.mock.calls.at(-1)![0] as Record<string, unknown>).Target as Record<
    string,
    unknown
  >

describe('jobWrapper functionArn', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    sendMock.mockResolvedValue({})
    mockLifecycle.startExecution.mockResolvedValue(makeExecutionContext())
    mockLifecycle.completeExecution.mockResolvedValue(undefined)
    mockLifecycle.failExecution.mockImplementation(scheduleRetry)
  })

  test('a retry scheduled from the wrapper targets the invoked Lambda, unqualified', async () => {
    const wrapped = jobWrapper(async () => { throw new Error('failed') })

    // The name does not end in `-sendEmail`: the retry still goes back to the Lambda
    // that ran the attempt.
    await invokeWrapped(wrapped, makeEvent(), makeContext(`${TEST_FUNCTION_ARN}:live`))

    expect(createCommandSpy).toHaveBeenCalledTimes(1)
    expect(lastTarget().Arn).toBe(TEST_FUNCTION_ARN)
  })

  test('another job targets the Lambda next to the invoked one', async () => {
    const wrapped = jobWrapper(async () => {
      await scheduler.createSchedule({
        id: 'chargeCard#uuid-1',
        jobName: 'chargeCard',
        jobSource: 'api',
        payload: {},
        maxRetryAttempts: 0,
        schedule: { delay: { value: 5, unit: 'minutes' } },
      })
    })

    await invokeWrapped(wrapped, makeEvent(), makeContext(`${TEST_FUNCTION_ARN}:live`))

    expect(lastTarget().Arn).toBe(
      'arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-chargeCard'
    )
  })

  test('config.functionArn wins', async () => {
    const functionArn = (jobName: string) =>
      `arn:aws:lambda:us-east-1:123456789012:function:workers-${jobName}`
    const wrapped = jobWrapper(async () => { throw new Error('failed') }, {
      config: { functionArn },
    })

    await invokeWrapped(wrapped, makeEvent(), makeContext())

    expect(lastTarget().Arn).toBe(
      'arn:aws:lambda:us-east-1:123456789012:function:workers-sendEmail'
    )
  })

  test('the scope reaches the lifecycle', async () => {
    let scope: JobScope | undefined
    mockLifecycle.failExecution.mockImplementation(async (event: JobEvent) => {
      scope = getScope()
      return scheduleRetry(event)
    })

    const config = { scheduleGroup: 'orders' }
    const onAlert = vi.fn()
    const wrapped = jobWrapper(async () => { throw new Error('failed') }, {
      config,
      onAlert,
    })

    await invokeWrapped(wrapped, makeEvent(), makeContext())

    expect(scope).toEqual({
      config,
      onAlert,
      invokedFunctionArn: TEST_FUNCTION_ARN,
      jobName: 'sendEmail',
    })
    expect(createCommandSpy.mock.calls.at(-1)![0]).toMatchObject({
      GroupName: 'orders',
      Target: { Arn: TEST_FUNCTION_ARN },
    })
  })
})

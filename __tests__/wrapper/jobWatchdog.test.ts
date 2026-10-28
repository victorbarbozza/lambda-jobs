import { beforeEach, describe, expect, mock, spyOn, test, vi } from 'bun:test'
import type { Context } from 'aws-lambda'
import type { Job } from '../../src/types/job.js'
import type { WatchdogResult } from '../../src/types/watchdog.js'
import { applyJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const { getLambdaArn } = await import('../../src/utils/lambda.js')
const { getJobsConfig } = await import('../../src/utils/jobsConfig.js')
const { jobWatchdog } = await import('../../src/wrapper/jobWatchdog.js')

const getOverdueJobs = spyOn(db, 'getOverdueJobs')
const getJobById = spyOn(db, 'getJobById')
const getOccurrenceExecutions = spyOn(db, 'getOccurrenceExecutions')
const moveDeadline = spyOn(db, 'moveDeadline')
const deleteSchedule = spyOn(scheduler, 'deleteSchedule')
const createRetrySchedule = spyOn(scheduler, 'createRetrySchedule')

const DEADLINE = '2026-01-01T00:10:00.000Z'

const SIBLING_ARN =
  'arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-sendEmail'

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'sendEmail#uuid-1',
  name: 'sendEmail',
  jobSource: 'api',
  status: 'scheduled',
  schedule: { delay: { value: 1, unit: 'minutes' } },
  payload: {},
  maxRetryAttempts: 2,
  failureStrategy: { action: 'continue', alert: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  lastScheduledTime: '2026-01-01T00:00:00Z',
  nextDeadline: DEADLINE,
  ...overrides,
})

/** Target of the retry schedule, read inside the watchdog scope. */
let retryTarget: { arn: string; group: string } | undefined

const lambdaContext = (arn = TEST_FUNCTION_ARN) =>
  ({ invokedFunctionArn: arn }) as Context

const run = (
  handler: ReturnType<typeof jobWatchdog>,
  context: Context = lambdaContext()
) => handler({}, context, () => {}) as Promise<WatchdogResult>

describe('jobWatchdog', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    retryTarget = undefined
    getOverdueJobs.mockResolvedValue({
      items: [{ jobId: 'sendEmail#uuid-1', deadline: DEADLINE }],
    })
    getJobById.mockResolvedValue(makeJob())
    getOccurrenceExecutions.mockResolvedValue([])
    moveDeadline.mockResolvedValue(undefined)
    deleteSchedule.mockResolvedValue(undefined)
    createRetrySchedule.mockImplementation(async (params) => {
      retryTarget = {
        arn: getLambdaArn(params.jobName),
        group: getJobsConfig().scheduleGroup,
      }
    })
  })

  describe('onAlert', () => {
    test('receives the overdue alert', async () => {
      const onAlert = vi.fn()

      await run(jobWatchdog({}, { onAlert }))

      expect(onAlert).toHaveBeenCalledTimes(1)
      expect(onAlert).toHaveBeenCalledWith({
        type: 'overdue',
        job: expect.objectContaining({ id: 'sendEmail#uuid-1' }),
        reason: 'never_delivered',
        deadline: DEADLINE,
        action: 'closed',
      })
    })

    test('without onAlert: logs the alert with console.warn', async () => {
      const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {})

      const result = await run(jobWatchdog())

      expect(result.findings).toHaveLength(1)
      expect(consoleWarn).toHaveBeenCalledTimes(1)
      expect(JSON.parse(consoleWarn.mock.calls[0]![0] as string)).toMatchObject({
        level: 'warn',
        alert: 'overdue',
      })
      consoleWarn.mockRestore()
    })

    test('onAlert that throws does not change the result', async () => {
      const onAlert = vi.fn(() => {
        throw new Error('webhook down')
      })
      const consoleError = spyOn(console, 'error').mockImplementation(() => {})

      const result = await run(jobWatchdog({}, { onAlert }))

      expect(result.findings[0]).toMatchObject({
        reason: 'never_delivered',
        action: 'closed',
      })
      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })
  })

  describe('onMissed run', () => {
    const definitions = { sendEmail: { onMissed: 'run' as const } }

    test('re-run targets the sibling Lambda derived from invokedFunctionArn', async () => {
      const result = await run(jobWatchdog(definitions, { onAlert: vi.fn() }))

      expect(result.findings[0]?.action).toBe('rescheduled')
      expect(retryTarget?.arn).toBe(SIBLING_ARN)
    })

    test('qualifier of invokedFunctionArn is dropped', async () => {
      await run(
        jobWatchdog(definitions, { onAlert: vi.fn() }),
        lambdaContext(`${TEST_FUNCTION_ARN}:live`)
      )

      expect(retryTarget?.arn).toBe(SIBLING_ARN)
    })

    test('config.functionArn wins over invokedFunctionArn', async () => {
      const functionArn = (jobName: string) =>
        `arn:aws:lambda:us-east-1:123456789012:function:jobs-${jobName}`

      await run(jobWatchdog(definitions, { config: { functionArn }, onAlert: vi.fn() }))

      expect(retryTarget?.arn).toBe(
        'arn:aws:lambda:us-east-1:123456789012:function:jobs-sendEmail'
      )
    })

    test('config.scheduleGroup is the group of the retry schedule', async () => {
      await run(
        jobWatchdog(definitions, {
          config: { scheduleGroup: 'acme-orders' },
          onAlert: vi.fn(),
        })
      )

      expect(retryTarget?.group).toBe('acme-orders')
    })

    test('without scheduleGroup: uses the default group', async () => {
      await run(jobWatchdog(definitions, { onAlert: vi.fn() }))

      expect(retryTarget?.group).toBe('default')
    })
  })
})

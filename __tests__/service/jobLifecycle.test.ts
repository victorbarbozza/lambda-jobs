import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  JobError,
  JobSkippedError,
  JobTerminalStateError,
} from '../../src/utils/errors.js'
import type { Job, JobExecution } from '../../src/types/job.js'
import type { JobEvent } from '../../src/types/event.js'
import { applyJobsTestEnv } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const commands = await import('../../src/service/commands.js')
const { startExecution, completeExecution, failExecution } = await import(
  '../../src/service/lifecycle/index.js'
)

const getJobById = spyOn(db, 'getJobById')
const moveDeadline = spyOn(db, 'moveDeadline')
const upsertExecution = spyOn(db, 'upsertExecution')
const getOccurrenceExecutions = spyOn(db, 'getOccurrenceExecutions')
const getExecutions = spyOn(db, 'getExecutions')
const getJobErrors = spyOn(db, 'getJobErrors')
const deleteSchedule = spyOn(scheduler, 'deleteSchedule')
const createRetrySchedule = spyOn(scheduler, 'createRetrySchedule')
const cancelJob = spyOn(commands, 'cancelJob')

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  name: 'sendEmail',
  jobSource: 'api',
  status: 'active',
  schedule: { delay: { value: 1, unit: 'minutes' } },
  payload: {},
  maxRetryAttempts: 2,
  failureStrategy: { action: 'continue', alert: false },
  createdAt: new Date().toISOString(),
  lastScheduledTime: '2026-01-01T00:00:00Z',
  nextDeadline: '2026-01-01T00:10:00.000Z',
  ...overrides,
})

const makeEvent = (overrides: Partial<JobEvent> = {}): JobEvent => ({
  id: 'job-1',
  name: 'sendEmail',
  jobSource: 'api',
  payload: {},
  scheduledTime: '2026-01-02T00:00:00Z',
  attempt: 1,
  maxRetryAttempts: 2,
  ...overrides,
})

const makeExecution = (overrides: Partial<JobExecution> = {}): JobExecution => ({
  scheduledTime: '2026-01-02T00:00:00Z',
  status: 'running',
  attempt: 1,
  startedAt: Date.now() - 5_000,
  expiresAt: Date.now() + 55_000,
  ...overrides,
})

const LAMBDA_TIMEOUT = 60_000

const DEADLINE = '2026-01-02T00:15:00.000Z'

const makeContext = (overrides: Partial<Job> = {}) => ({
  execution: makeExecution(),
  jobEntity: makeJob(overrides),
  isNewExecution: true,
  attempt: 1,
  deadline: DEADLINE,
})

describe('lifecycle', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    moveDeadline.mockResolvedValue(undefined)
    upsertExecution.mockResolvedValue(undefined)
    getOccurrenceExecutions.mockResolvedValue([])
    getExecutions.mockResolvedValue([])
    getJobErrors.mockResolvedValue([])
    deleteSchedule.mockResolvedValue(undefined)
    createRetrySchedule.mockResolvedValue(undefined)
    cancelJob.mockResolvedValue(true)
    getJobById.mockResolvedValue(makeJob())
  })

  describe('startExecution', () => {
    test('nonexistent job throws JobError', async () => {
      getJobById.mockResolvedValue(null)

      await expect(startExecution(makeEvent(), LAMBDA_TIMEOUT)).rejects.toThrow(
        JobError
      )
    })

    test.each(['cancelled', 'completed', 'failed'] as const)(
      'job %s throws JobTerminalStateError',
      async (status) => {
        getJobById.mockResolvedValue(makeJob({ status }))

        await expect(startExecution(makeEvent(), LAMBDA_TIMEOUT)).rejects.toThrow(
          JobTerminalStateError
        )
      }
    )

    test('no previous execution: opens attempt 1', async () => {
      const ctx = await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(ctx.attempt).toBe(1)
      expect(ctx.isNewExecution).toBe(true)
      expect(ctx.execution.expiresAt).toBeGreaterThan(ctx.execution.startedAt)
    })

    test('with failed previous execution: opens the next attempt', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ status: 'failed', attempt: 1 }),
      ])

      const ctx = await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(ctx.attempt).toBe(2)
      expect(ctx.isNewExecution).toBe(false)
    })

    test('occurrence already completed throws JobTerminalStateError', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ status: 'completed' }),
      ])

      await expect(startExecution(makeEvent(), LAMBDA_TIMEOUT)).rejects.toThrow(
        JobTerminalStateError
      )
    })

    test('attempt within the deadline throws JobSkippedError', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ status: 'running', expiresAt: Date.now() + 30_000 }),
      ])

      await expect(startExecution(makeEvent(), LAMBDA_TIMEOUT)).rejects.toThrow(
        JobSkippedError
      )
    })

    test('attempt with expired deadline is closed and the occurrence goes on', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ status: 'running', expiresAt: Date.now() - 1_000 }),
      ])

      const ctx = await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(ctx.attempt).toBe(2)
      expect(upsertExecution).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          attempt: 1,
          status: 'failed',
          error: expect.objectContaining({ code: 'ERR_JOB_ABANDONED' }),
        })
      )
    })

    test('first occurrence moves the deadline and sets lastScheduledTime', async () => {
      await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        '2026-01-01T00:10:00.000Z',
        expect.any(String),
        expect.objectContaining({ lastScheduledTime: '2026-01-02T00:00:00Z' })
      )
    })

    test('deadlineToleranceSeconds from the definition sets the deadline leeway', async () => {
      const ctx = await startExecution(makeEvent(), LAMBDA_TIMEOUT, {
        deadlineToleranceSeconds: 30,
      })

      const leeway = new Date(ctx.deadline).getTime() - ctx.execution.expiresAt

      expect(leeway).toBe(30_000)
    })

    test('no executionRetentionDays: execution stored without ttl', async () => {
      await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      const [, execution] = upsertExecution.mock.calls[0]!
      expect(execution).not.toHaveProperty('ttl')
    })

    test('with executionRetentionDays: ttl in seconds within the requested window', async () => {
      await startExecution(makeEvent(), LAMBDA_TIMEOUT, {
        executionRetentionDays: 30,
      })

      const [, execution] = upsertExecution.mock.calls[0]!
      const expected = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

      expect(Math.abs(execution.ttl! - expected)).toBeLessThan(5)
    })

    test('retry inherits the ttl of the first attempt of the occurrence', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ status: 'failed', attempt: 1, ttl: 1_800_000_000 }),
      ])

      await startExecution(makeEvent(), LAMBDA_TIMEOUT, {
        executionRetentionDays: 30,
      })

      const [, execution] = upsertExecution.mock.calls[0]!
      expect(execution.ttl).toBe(1_800_000_000)
    })

    test('deadline returned in the context is the same stored in the database', async () => {
      const ctx = await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        expect.anything(),
        ctx.deadline,
        expect.anything()
      )
    })

    test('recurring on the first occurrence becomes active', async () => {
      getJobById.mockResolvedValue(
        makeJob({ status: 'scheduled', schedule: { cron: '0 12 * * ? *' } })
      )

      await startExecution(makeEvent(), LAMBDA_TIMEOUT)

      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ status: 'active' })
      )
    })

    test('expired schedule closes the job', async () => {
      getJobById.mockResolvedValue(
        makeJob({
          schedule: {
            rate: { value: 1, unit: 'hours' },
            endDate: new Date(Date.now() - 86_400_000).toISOString(),
          },
        })
      )

      await expect(startExecution(makeEvent(), LAMBDA_TIMEOUT)).rejects.toThrow(
        JobTerminalStateError
      )
      expect(deleteSchedule).toHaveBeenCalled()
    })
  })

  describe('completeExecution', () => {
    test('once job closes as completed', async () => {
      await completeExecution(makeEvent(), makeContext())

      expect(upsertExecution).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({ status: 'completed' })
      )
      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        undefined,
        expect.objectContaining({ status: 'completed' })
      )
    })

    test('active recurring points the deadline to the next occurrence', async () => {
      const ctx = makeContext({ schedule: { rate: { value: 1, unit: 'hours' } } })

      await completeExecution(makeEvent(), ctx)

      expect(deleteSchedule).not.toHaveBeenCalled()
      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        expect.any(String),
        expect.anything()
      )
    })
  })

  describe('failExecution', () => {
    test('with attempt left schedules the next one', async () => {
      const result = await failExecution(
        makeEvent(),
        new Error('failed'),
        makeContext()
      )

      expect(result.outcome).toBe('retry')
      expect(createRetrySchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledTime: '2026-01-02T00:00:00Z',
          attempt: 2,
        })
      )
    })

    test('retryDelay from the definition sets the wait', async () => {
      await failExecution(makeEvent(), new Error('failed'), makeContext(), {
        retryDelay: () => 120,
      })

      const { runAt } = createRetrySchedule.mock.calls[0]![0]
      const wait = new Date(runAt).getTime() - Date.now()

      expect(wait).toBeGreaterThan(110_000)
      expect(wait).toBeLessThan(130_000)
    })

    test('retryIn from the handler takes precedence over the definition', async () => {
      await failExecution(
        makeEvent(),
        new Error('failed'),
        makeContext(),
        { retryDelay: () => 3600 },
        { retryInSeconds: 45 }
      )

      const { runAt } = createRetrySchedule.mock.calls[0]![0]
      const wait = new Date(runAt).getTime() - Date.now()

      expect(wait).toBeLessThan(60_000)
    })

    test('giveUp closes even with attempts available', async () => {
      const result = await failExecution(
        makeEvent({ maxRetryAttempts: 5 }),
        new Error('no point insisting'),
        makeContext(),
        undefined,
        { giveUp: true }
      )

      expect(result.outcome).toBe('exhausted')
      expect(createRetrySchedule).not.toHaveBeenCalled()
    })

    test('giveUp beats the retryIn asked in the same execution', async () => {
      await failExecution(
        makeEvent({ maxRetryAttempts: 5 }),
        new Error('failed'),
        makeContext(),
        undefined,
        { giveUp: true, retryInSeconds: 30 }
      )

      expect(createRetrySchedule).not.toHaveBeenCalled()
    })

    test('with no attempt left returns exhausted with the failures of the occurrence', async () => {
      getOccurrenceExecutions.mockResolvedValue([
        makeExecution({ attempt: 1, status: 'completed' }),
        makeExecution({
          attempt: 2,
          status: 'failed',
          error: { message: 'first failure' },
        }),
        makeExecution({
          attempt: 3,
          status: 'failed',
          error: { message: 'last failure' },
        }),
      ])

      const result = await failExecution(
        makeEvent({ maxRetryAttempts: 2 }),
        new Error('failed'),
        { ...makeContext(), attempt: 3 }
      )

      expect(result.outcome).toBe('exhausted')
      if (result.outcome === 'exhausted') {
        expect(result.errors.map((e) => e.message)).toEqual([
          'first failure',
          'last failure',
        ])
      }
      expect(createRetrySchedule).not.toHaveBeenCalled()
    })

    test('errors come from the query scoped to the occurrence, not from the job history', async () => {
      await failExecution(
        makeEvent({ maxRetryAttempts: 0, scheduledTime: '2026-01-02T00:00:00Z' }),
        new Error('failed'),
        { ...makeContext(), attempt: 1 }
      )

      // Reading the whole history to discard almost all of it is a cost that keeps
      // growing on an old recurring job.
      expect(getOccurrenceExecutions).toHaveBeenCalledWith(
        'job-1',
        '2026-01-02T00:00:00Z'
      )
      expect(getJobErrors).not.toHaveBeenCalled()
    })

    test('retryMaxAgeMinutes stored on the job applies without the wrapper repeating it', async () => {
      // The rule lives in the lifecycle, which runs in the execution Lambda. Without
      // reading it from the job, the cap — including the 60min default — would only
      // exist for whoever repeated the setting in `jobWrapper`.
      const result = await failExecution(
        makeEvent({ scheduledTime: new Date(Date.now() - 7_200_000).toISOString() }),
        new Error('failed'),
        makeContext({ retryMaxAgeMinutes: 60 })
      )

      expect(result.outcome).toBe('exhausted')
      expect(createRetrySchedule).not.toHaveBeenCalled()
    })

    test('wrapper definition takes precedence over the one stored on the job', async () => {
      const result = await failExecution(
        makeEvent({ scheduledTime: new Date(Date.now() - 7_200_000).toISOString() }),
        new Error('failed'),
        makeContext({ retryMaxAgeMinutes: 60 }),
        { retryMaxAgeMinutes: 1440 }
      )

      expect(result.outcome).toBe('retry')
      expect(createRetrySchedule).toHaveBeenCalled()
    })

    test('with no cap anywhere, the occurrence only stops at maxRetryAttempts', async () => {
      const result = await failExecution(
        makeEvent({ scheduledTime: new Date(Date.now() - 7_200_000).toISOString() }),
        new Error('failed'),
        makeContext()
      )

      expect(result.outcome).toBe('retry')
    })

    test('expired retryMaxAgeMinutes closes without a new attempt', async () => {
      const result = await failExecution(
        makeEvent({ scheduledTime: new Date(Date.now() - 7_200_000).toISOString() }),
        new Error('failed'),
        makeContext(),
        { retryMaxAgeMinutes: 60 }
      )

      expect(result.outcome).toBe('exhausted')
      expect(createRetrySchedule).not.toHaveBeenCalled()
    })

    test('strategy cancel cancels the job when exhausted', async () => {
      await failExecution(
        makeEvent({ maxRetryAttempts: 0 }),
        new Error('failed'),
        { ...makeContext({ failureStrategy: { action: 'cancel', alert: true } }), attempt: 1 }
      )

      expect(cancelJob).toHaveBeenCalledWith('job-1')
    })

    test('strategy continue on recurring points the deadline to the next occurrence', async () => {
      await failExecution(makeEvent({ maxRetryAttempts: 0 }), new Error('failed'), {
        ...makeContext({ schedule: { rate: { value: 1, unit: 'hours' } } }),
        attempt: 1,
      })

      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        expect.any(String),
        expect.objectContaining({ nextRetryAt: undefined })
      )
    })

    test('deadlineToleranceSeconds from the definition sets the retry deadline', async () => {
      await failExecution(makeEvent(), new Error('failed'), makeContext(), {
        retryDelay: () => 60,
        deadlineToleranceSeconds: 30,
      })

      const [, , to] = moveDeadline.mock.calls[0]!
      const { runAt } = createRetrySchedule.mock.calls[0]![0]
      const leeway = new Date(to!).getTime() - new Date(runAt).getTime()

      expect(leeway).toBe(30_000)
    })

    test('strategy continue on once job closes as failed', async () => {
      await failExecution(makeEvent({ maxRetryAttempts: 0 }), new Error('failed'), {
        ...makeContext(),
        attempt: 1,
      })

      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        undefined,
        expect.objectContaining({ status: 'failed' })
      )
    })
  })
})

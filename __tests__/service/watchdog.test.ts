import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import type { Job, JobExecution } from '../../src/types/job.js'
import { applyJobsTestEnv } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const notification = await import('../../src/connectors/notification.js')
const commands = await import('../../src/service/commands.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const { runWatchdog, diagnose } = await import('../../src/service/watchdog.js')

const getOverdueJobs = spyOn(db, 'getOverdueJobs')
const getJobById = spyOn(db, 'getJobById')
const getOccurrenceExecutions = spyOn(db, 'getOccurrenceExecutions')
const upsertExecution = spyOn(db, 'upsertExecution')
const clearDeadline = spyOn(db, 'clearDeadline')
const moveDeadline = spyOn(db, 'moveDeadline')
const deleteSchedule = spyOn(scheduler, 'deleteSchedule')
const retryNow = spyOn(commands, 'retryNow')
const sendNotification = spyOn(notification, 'sendNotification')

const DEADLINE = '2026-01-01T00:10:00.000Z'

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
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

const makeExecution = (overrides: Partial<JobExecution> = {}): JobExecution => ({
  scheduledTime: '2026-01-01T00:00:00Z',
  status: 'running',
  attempt: 1,
  startedAt: Date.now() - 600_000,
  expiresAt: Date.now() - 540_000,
  ...overrides,
})

const overduePage = (items = [{ jobId: 'job-1', deadline: DEADLINE }], nextPageToken?: Record<string, AttributeValue>) => ({
  items,
  nextPageToken,
})

describe('watchdog', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    getOverdueJobs.mockResolvedValue(overduePage())
    getJobById.mockResolvedValue(makeJob())
    getOccurrenceExecutions.mockResolvedValue([])
    upsertExecution.mockResolvedValue(undefined)
    clearDeadline.mockResolvedValue(undefined)
    moveDeadline.mockResolvedValue(undefined)
    deleteSchedule.mockResolvedValue(undefined)
    retryNow.mockResolvedValue(true)
    sendNotification.mockResolvedValue(undefined)
  })

  describe('runWatchdog', () => {
    test('no overdue deadlines: does not notify anything', async () => {
      getOverdueJobs.mockResolvedValue(overduePage([]))

      const result = await runWatchdog()

      expect(result).toEqual({ examined: 0, findings: [], truncated: false })
      expect(sendNotification).not.toHaveBeenCalled()
    })

    test('orphan deadline (job already removed): clears and does not notify', async () => {
      getJobById.mockResolvedValue(null)

      const result = await runWatchdog()

      expect(clearDeadline).toHaveBeenCalledWith('job-1', DEADLINE)
      expect(result.findings).toHaveLength(0)
      expect(sendNotification).not.toHaveBeenCalled()
    })

    test('no execution at all: classifies as never_delivered and closes the job', async () => {
      const result = await runWatchdog()

      expect(result.findings[0]).toMatchObject({
        jobId: 'job-1',
        reason: 'never_delivered',
        action: 'closed',
      })
      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        undefined,
        expect.objectContaining({ status: 'failed' })
      )
      expect(deleteSchedule).toHaveBeenCalledWith('job-1')
      expect(sendNotification).toHaveBeenCalledTimes(1)
    })

    test('execution stuck in running: classifies invocation_died and closes the attempt', async () => {
      getOccurrenceExecutions.mockResolvedValue([makeExecution()])

      const result = await runWatchdog()

      expect(result.findings[0]?.reason).toBe('invocation_died')
      expect(upsertExecution).toHaveBeenCalledWith(
        'job-1',
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ code: 'ERR_JOB_ABANDONED' }),
        })
      )
    })

    test('job with pending retry: classifies retry_lost', async () => {
      getJobById.mockResolvedValue(makeJob({ nextRetryAt: '2026-01-01T00:05:00.000Z' }))

      const result = await runWatchdog()

      expect(result.findings[0]?.reason).toBe('retry_lost')
    })

    test('active recurring: classifies recurrence_stalled and pushes the deadline', async () => {
      getJobById.mockResolvedValue(
        makeJob({ status: 'active', schedule: { rate: { value: 1, unit: 'hours' } } })
      )

      const result = await runWatchdog()

      expect(result.findings[0]?.reason).toBe('recurrence_stalled')
      expect(result.findings[0]?.action).toBe('deadline_pushed')
      // Clearing the deadline here would leave precisely the job that stopped firing
      // invisible to the following watchdog passes.
      expect(moveDeadline).toHaveBeenCalledWith(
        'job-1',
        DEADLINE,
        expect.any(String),
        {}
      )
      expect(deleteSchedule).not.toHaveBeenCalled()
    })

    test('stalled recurring stays under observation with a deadline in the future', async () => {
      getJobById.mockResolvedValue(
        makeJob({ status: 'active', schedule: { rate: { value: 1, unit: 'hours' } } })
      )

      await runWatchdog()

      const [, , to] = moveDeadline.mock.calls[0]!
      expect(new Date(to!).getTime()).toBeGreaterThan(Date.now())
    })

    test('onMissed run: re-runs the occurrence instead of closing', async () => {
      const result = await runWatchdog({ sendEmail: { onMissed: 'run' } })

      expect(retryNow).toHaveBeenCalledWith('job-1')
      expect(deleteSchedule).not.toHaveBeenCalled()
      expect(result.findings[0]?.action).toBe('rescheduled')
    })

    test('onMissed run does NOT apply to stalled recurring', async () => {
      getJobById.mockResolvedValue(makeJob({ status: 'active' }))

      await runWatchdog({ sendEmail: { onMissed: 'run' } })

      expect(retryNow).not.toHaveBeenCalled()
      expect(moveDeadline).toHaveBeenCalled()
    })

    test('onMissed run that cannot reschedule closes the job', async () => {
      retryNow.mockResolvedValue(false)

      const result = await runWatchdog({ sendEmail: { onMissed: 'run' } })

      expect(result.findings[0]?.action).toBe('closed')
      expect(deleteSchedule).toHaveBeenCalledWith('job-1')
    })

    test('deadline of job already terminal is cleared without alerting', async () => {
      getJobById.mockResolvedValue(makeJob({ status: 'completed' }))

      const result = await runWatchdog()

      expect(clearDeadline).toHaveBeenCalledWith('job-1', DEADLINE)
      expect(result.findings).toHaveLength(0)
      expect(sendNotification).not.toHaveBeenCalled()
    })

    test('page with continuation sets truncated', async () => {
      getOverdueJobs.mockResolvedValue(
        overduePage([{ jobId: 'job-1', deadline: DEADLINE }], { token: { S: 'token' } })
      )

      const result = await runWatchdog()

      expect(result.truncated).toBe(true)
    })

    test('queries the deadlines overdue until now with the given page size', async () => {
      await runWatchdog({}, 25)

      expect(getOverdueJobs).toHaveBeenCalledWith(expect.any(String), 25)
    })
  })

  describe('diagnose', () => {
    test('classifies without applying side effects', async () => {
      getOccurrenceExecutions.mockResolvedValue([makeExecution()])

      const result = await diagnose()

      expect(result.overdue[0]).toMatchObject({
        jobId: 'job-1',
        name: 'sendEmail',
        reason: 'invocation_died',
        deadline: DEADLINE,
      })
      expect(moveDeadline).not.toHaveBeenCalled()
      expect(upsertExecution).not.toHaveBeenCalled()
      expect(sendNotification).not.toHaveBeenCalled()
    })

    test('ignores deadline whose job no longer exists', async () => {
      getJobById.mockResolvedValue(null)

      const result = await diagnose()

      expect(result.overdue).toHaveLength(0)
      expect(clearDeadline).not.toHaveBeenCalled()
    })
  })
})

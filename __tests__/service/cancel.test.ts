import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { Job } from '../../src/types/job.js'
import { JobSchedulerError } from '../../src/utils/errors.js'
import { applyJobsTestEnv } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const { cancelJob, retryNow } = await import('../../src/service/commands.js')

const getJobById = spyOn(db, 'getJobById')
const moveDeadline = spyOn(db, 'moveDeadline')
const getOccurrenceExecutions = spyOn(db, 'getOccurrenceExecutions')
const deleteSchedule = spyOn(scheduler, 'deleteSchedule')
const createRetrySchedule = spyOn(scheduler, 'createRetrySchedule')

const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 'job-1',
  name: 'sendEmail',
  jobSource: 'api',
  status: 'active',
  schedule: { delay: { value: 1, unit: 'minutes' } },
  payload: {},
  maxRetryAttempts: 0,
  failureStrategy: { action: 'continue', alert: false },
  createdAt: new Date().toISOString(),
  ...overrides,
})

describe('cancelJob', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    moveDeadline.mockResolvedValue(undefined)
    deleteSchedule.mockResolvedValue(undefined)
    createRetrySchedule.mockResolvedValue(undefined)
    getOccurrenceExecutions.mockResolvedValue([])
  })

  test('active job: updates status to cancelled, deletes schedule, returns true', async () => {
    getJobById.mockResolvedValue(makeJob({ status: 'active' }))

    const result = await cancelJob('job-1')

    expect(result).toBe(true)
    expect(moveDeadline).toHaveBeenCalledWith(
      'job-1',
      undefined,
      undefined,
      expect.objectContaining({ status: 'cancelled' })
    )
    expect(deleteSchedule).toHaveBeenCalledWith('job-1')
  })

  test('job does not exist: tries to delete schedule (orphan cleanup), returns false', async () => {
    getJobById.mockResolvedValue(null)

    const result = await cancelJob('job-x')

    expect(result).toBe(false)
    expect(deleteSchedule).toHaveBeenCalledWith('job-x')
    expect(moveDeadline).not.toHaveBeenCalled()
  })

  test('job does not exist + deleteSchedule fails for another reason: propagates error', async () => {
    getJobById.mockResolvedValue(null)
    deleteSchedule.mockRejectedValue(new JobSchedulerError('aws down'))

    await expect(cancelJob('job-x')).rejects.toThrow('aws down')
  })

  test('job already completed: does nothing, returns false', async () => {
    getJobById.mockResolvedValue(makeJob({ status: 'completed' }))

    const result = await cancelJob('job-1')

    expect(result).toBe(false)
    expect(moveDeadline).not.toHaveBeenCalled()
    expect(deleteSchedule).not.toHaveBeenCalled()
  })

  test('job already cancelled: does nothing, returns false', async () => {
    getJobById.mockResolvedValue(makeJob({ status: 'cancelled' }))

    const result = await cancelJob('job-1')

    expect(result).toBe(false)
    expect(moveDeadline).not.toHaveBeenCalled()
  })

  test('db.moveDeadline throws when cancelling active job: error propagates', async () => {
    getJobById.mockResolvedValue(makeJob({ status: 'active' }))
    moveDeadline.mockRejectedValue(new Error('db error'))

    await expect(cancelJob('job-1')).rejects.toThrow('db error')
  })

  test('active job + deleteSchedule fails for another reason: propagates error', async () => {
    getJobById.mockResolvedValue(makeJob({ status: 'active' }))
    deleteSchedule.mockRejectedValue(new JobSchedulerError('aws down'))

    await expect(cancelJob('job-1')).rejects.toThrow('aws down')
  })

  test('with pending retry: also removes the retry schedule', async () => {
    getJobById.mockResolvedValue(
      makeJob({
        status: 'active',
        nextRetryAt: '2026-01-01T00:05:00.000Z',
        lastScheduledTime: '2026-01-01T00:00:00Z',
      })
    )
    getOccurrenceExecutions.mockResolvedValue([
      {
        scheduledTime: '2026-01-01T00:00:00Z',
        status: 'failed',
        attempt: 2,
        startedAt: 0,
        expiresAt: 0,
      },
    ])

    await cancelJob('job-1')

    expect(deleteSchedule).toHaveBeenCalledWith('job-1')
    expect(deleteSchedule).toHaveBeenCalledWith('job-1-r3')
  })
})

describe('retryNow', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    moveDeadline.mockResolvedValue(undefined)
    deleteSchedule.mockResolvedValue(undefined)
    createRetrySchedule.mockResolvedValue(undefined)
    getOccurrenceExecutions.mockResolvedValue([])
  })

  test('nonexistent job: returns false without scheduling', async () => {
    getJobById.mockResolvedValue(null)

    expect(await retryNow('job-x')).toBe(false)
    expect(createRetrySchedule).not.toHaveBeenCalled()
  })

  test.each(['cancelled', 'completed', 'failed'] as const)(
    'job %s: returns false without scheduling',
    async (status) => {
      getJobById.mockResolvedValue(makeJob({ status }))

      expect(await retryNow('job-1')).toBe(false)
      expect(createRetrySchedule).not.toHaveBeenCalled()
    }
  )

  test('schedules the next attempt for the same occurrence', async () => {
    getJobById.mockResolvedValue(
      makeJob({ status: 'active', lastScheduledTime: '2026-01-01T00:00:00Z' })
    )
    getOccurrenceExecutions.mockResolvedValue([
      {
        scheduledTime: '2026-01-01T00:00:00Z',
        status: 'failed',
        attempt: 1,
        startedAt: 0,
        expiresAt: 0,
      },
    ])

    expect(await retryNow('job-1')).toBe(true)
    expect(createRetrySchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'job-1',
        scheduledTime: '2026-01-01T00:00:00Z',
        attempt: 2,
      })
    )
  })

  test('moves the deadline to the new attempt and records nextRetryAt', async () => {
    getJobById.mockResolvedValue(
      makeJob({
        status: 'active',
        lastScheduledTime: '2026-01-01T00:00:00Z',
        nextDeadline: '2026-01-01T00:10:00.000Z',
      })
    )

    await retryNow('job-1')

    expect(moveDeadline).toHaveBeenCalledWith(
      'job-1',
      '2026-01-01T00:10:00.000Z',
      expect.any(String),
      expect.objectContaining({ nextRetryAt: expect.any(String) })
    )
  })
})

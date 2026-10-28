import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { JobValidationError } from '../../src/utils/errors.js'
import type { JobDefinitions } from '../../src/types/job.js'
import { applyJobsTestEnv } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const scheduler = await import('../../src/connectors/eventBridgeScheduler.js')
const { createJob } = await import('../../src/service/commands.js')

const dbCreateJob = spyOn(db, 'createJob')
const deleteJob = spyOn(db, 'deleteJob')
const createSchedule = spyOn(scheduler, 'createSchedule')

const jobDefinitions: JobDefinitions = {
  sendEmail: {
    maxRetryAttempts: 3,
    failureStrategy: { action: 'cancel', alert: true },
    schedule: { delay: { value: 5, unit: 'minutes' } },
  },
  minimalJob: {},
}

describe('createJob', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    dbCreateJob.mockResolvedValue(undefined)
    deleteJob.mockResolvedValue(undefined)
    createSchedule.mockResolvedValue(undefined)
  })

  describe('success flow', () => {
    test('returns id in the name#uuid format', async () => {
      const id = await createJob(
        'sendEmail',
        'api',
        { to: 'a@b.com' },
        undefined,
        jobDefinitions
      )

      expect(id).toMatch(/^sendEmail#[0-9a-f-]{36}$/)
    })

    test('calls db.createJob with status scheduled', async () => {
      await createJob(
        'sendEmail',
        'api',
        { to: 'a@b.com' },
        undefined,
        jobDefinitions
      )

      expect(dbCreateJob).toHaveBeenCalledTimes(1)
      const job = dbCreateJob.mock.calls[0][0]
      expect(job.status).toBe('scheduled')
    })

    test('calls scheduler.createSchedule with params derived from the definition', async () => {
      await createJob(
        'sendEmail',
        'api',
        { to: 'a@b.com' },
        undefined,
        jobDefinitions
      )

      expect(createSchedule).toHaveBeenCalledTimes(1)
      const params = createSchedule.mock.calls[0][0]
      expect(params.jobName).toBe('sendEmail')
      expect(params.jobSource).toBe('api')
      expect(params.maxRetryAttempts).toBe(3)
    })

    test('flexible window goes into the first delivery deadline', async () => {
      const defs: JobDefinitions = {
        flexible: {
          flexibleWindowMinutes: 15,
          schedule: { at: new Date(Date.now() + 60_000).toISOString() },
        },
      }

      await createJob('flexible', 'api', {}, undefined, defs)

      const job = dbCreateJob.mock.calls[0][0]
      const leeway = new Date(job.nextDeadline!).getTime() - (Date.now() + 60_000)

      // Without adding the window, the watchdog would flag as late a job that the
      // Scheduler is still allowed to deliver.
      expect(leeway).toBeGreaterThan(15 * 60 * 1000)
    })

    test('flexible window is stored on the job, for whoever runs it to see', async () => {
      const defs: JobDefinitions = { flexible: { flexibleWindowMinutes: 10 } }

      await createJob('flexible', 'api', {}, undefined, defs)

      expect(dbCreateJob.mock.calls[0][0].flexibleWindowMinutes).toBe(10)
    })

    test('retryMaxAgeMinutes is stored on the job', async () => {
      const defs: JobDefinitions = { short: { retryMaxAgeMinutes: 15 } }

      await createJob('short', 'api', {}, undefined, defs)

      expect(dbCreateJob.mock.calls[0][0].retryMaxAgeMinutes).toBe(15)
    })

    test('no retryMaxAgeMinutes in the definition: stores the default', async () => {
      // Before, the default only fed the validations and never reached the execution:
      // whoever did not repeat the setting in the wrapper had no age cap at all.
      await createJob('minimalJob', 'api', {}, undefined, jobDefinitions)

      expect(dbCreateJob.mock.calls[0][0].retryMaxAgeMinutes).toBe(60)
    })

    test('db.createJob is called BEFORE scheduler.createSchedule', async () => {
      const order: string[] = []
      dbCreateJob.mockImplementation(() => {
        order.push('db')
        return Promise.resolve()
      })
      createSchedule.mockImplementation(() => {
        order.push('scheduler')
        return Promise.resolve()
      })

      await createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      expect(order).toEqual(['db', 'scheduler'])
    })
  })

  describe('defaults merge', () => {
    test('no maxRetryAttempts in the definition: uses 0', async () => {
      await createJob('minimalJob', 'api', {}, undefined, jobDefinitions)

      const job = dbCreateJob.mock.calls[0][0]
      expect(job.maxRetryAttempts).toBe(0)
    })

    test('no failureStrategy in the definition: uses continue/false', async () => {
      await createJob('minimalJob', 'api', {}, undefined, jobDefinitions)

      const job = dbCreateJob.mock.calls[0][0]
      expect(job.failureStrategy).toEqual({ action: 'continue', alert: false })
    })

    test('schedule passed to createJob overrides the JobDefinition one', async () => {
      const customSchedule = { cron: '0 12 * * ? *' }
      await createJob('sendEmail', 'api', {}, customSchedule, jobDefinitions)

      const job = dbCreateJob.mock.calls[0][0]
      expect(job.schedule).toEqual(customSchedule)
    })

    test('no schedule anywhere: uses default delay 5 minutes', async () => {
      await createJob('minimalJob', 'api', {}, undefined, jobDefinitions)

      const job = dbCreateJob.mock.calls[0][0]
      expect(job.schedule).toEqual({ delay: { value: 5, unit: 'minutes' } })
    })
  })

  describe('validations', () => {
    test('negative maxRetryAttempts throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { maxRetryAttempts: -1 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('maxRetryAttempts above the EventBridge limit throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { maxRetryAttempts: 185 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('negative flexibleWindowMinutes throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { flexibleWindowMinutes: -1 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('empty name throws JobValidationError', async () => {
      await expect(
        createJob('' as string, 'api', {}, undefined, jobDefinitions)
      ).rejects.toThrow(JobValidationError)
    })

    test('retryMaxAgeMinutes <= 0 throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { retryMaxAgeMinutes: 0 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('retryMaxAgeMinutes > 1440 throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { retryMaxAgeMinutes: 1441 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('schedule with rate.value <= 0 throws JobValidationError', async () => {
      await expect(
        createJob(
          'sendEmail',
          'api',
          {},
          { rate: { value: 0, unit: 'minutes' } },
          jobDefinitions
        )
      ).rejects.toThrow(JobValidationError)
    })

    test('schedule with delay.value <= 0 throws JobValidationError', async () => {
      await expect(
        createJob(
          'sendEmail',
          'api',
          {},
          { delay: { value: -1, unit: 'minutes' } },
          jobDefinitions
        )
      ).rejects.toThrow(JobValidationError)
    })

    test('flexibleWindowMinutes above the EventBridge limit throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { flexibleWindowMinutes: 1441 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('executionRetentionDays <= 0 throws JobValidationError', async () => {
      const defs: JobDefinitions = { bad: { executionRetentionDays: 0 } }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('executionRetentionDays less than retryMaxAgeMinutes throws JobValidationError', async () => {
      const defs: JobDefinitions = {
        bad: { executionRetentionDays: 1, retryMaxAgeMinutes: 1440 + 1 },
      }
      await expect(
        createJob('bad', 'api', {}, undefined, defs)
      ).rejects.toThrow(JobValidationError)
    })

    test('missing executionRetentionDays is valid (history does not expire)', async () => {
      await createJob('minimalJob', 'api', {}, undefined, jobDefinitions)

      expect(dbCreateJob).toHaveBeenCalledTimes(1)
    })

    test('cron with 5 fields (Unix standard) throws JobValidationError', async () => {
      await expect(
        createJob('sendEmail', 'api', {}, { cron: '0 12 * * *' }, jobDefinitions)
      ).rejects.toThrow(JobValidationError)
    })

    test('at with invalid date throws JobValidationError', async () => {
      await expect(
        createJob('sendEmail', 'api', {}, { at: 'not-a-date' }, jobDefinitions)
      ).rejects.toThrow(JobValidationError)
    })

    test('at in the past throws JobValidationError', async () => {
      await expect(
        createJob(
          'sendEmail',
          'api',
          {},
          { at: '2020-01-01T00:00:00Z' },
          jobDefinitions
        )
      ).rejects.toThrow(JobValidationError)
    })

    test('endDate in the past throws JobValidationError', async () => {
      await expect(
        createJob(
          'sendEmail',
          'api',
          {},
          { cron: '0 12 * * ? *', endDate: '2020-01-01T00:00:00Z' },
          jobDefinitions
        )
      ).rejects.toThrow(JobValidationError)
    })

    test('future at and future endDate pass validation', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString()

      await createJob('sendEmail', 'api', {}, { at: future }, jobDefinitions)
      await createJob(
        'sendEmail',
        'api',
        {},
        { cron: '0 12 * * ? *', endDate: future },
        jobDefinitions
      )

      expect(createSchedule).toHaveBeenCalledTimes(2)
    })
  })

  describe('compensation', () => {
    test('if scheduler.createSchedule fails: calls db.deleteJob and propagates error', async () => {
      const schedulerError = new Error('EventBridge down')
      createSchedule.mockRejectedValue(schedulerError)

      await expect(
        createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      ).rejects.toThrow(schedulerError)

      expect(deleteJob).toHaveBeenCalledTimes(1)
      expect(deleteJob).toHaveBeenCalledWith(
        expect.stringMatching(/^sendEmail#[0-9a-f-]{36}$/),
        'api',
        expect.any(String)
      )
    })

    test('if scheduler.createSchedule succeeds: does NOT call db.deleteJob', async () => {
      await createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      expect(deleteJob).not.toHaveBeenCalled()
    })
  })

  describe('infra failures', () => {
    test('db.createJob throws: error propagates, scheduler is NOT called', async () => {
      const dbError = new Error('DynamoDB down')
      dbCreateJob.mockRejectedValue(dbError)

      await expect(
        createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      ).rejects.toThrow(dbError)

      expect(createSchedule).not.toHaveBeenCalled()
    })

    test('db.createJob throws: db.deleteJob is NOT called', async () => {
      dbCreateJob.mockRejectedValue(new Error('fail'))

      await expect(
        createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      ).rejects.toThrow()

      expect(deleteJob).not.toHaveBeenCalled()
    })

    test('compensation fails: deleteJob error propagates', async () => {
      createSchedule.mockRejectedValue(new Error('sched'))
      const deleteError = new Error('delete fail')
      deleteJob.mockRejectedValue(deleteError)

      await expect(
        createJob('sendEmail', 'api', {}, undefined, jobDefinitions)
      ).rejects.toThrow(deleteError)
    })
  })
})

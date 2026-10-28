import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { applyJobsTestEnv } from './helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../src/db/entities.js')
const scheduler = await import('../src/connectors/eventBridgeScheduler.js')
const { createJobScheduler } = await import('../src/index.js')

const dbCreateJob = spyOn(db, 'createJob')
const getJobById = spyOn(db, 'getJobById')
const getJobErrors = spyOn(db, 'getJobErrors')
const getExecutions = spyOn(db, 'getExecutions')
const getLatestExecutions = spyOn(db, 'getLatestExecutions')
const getOccurrenceExecutions = spyOn(db, 'getOccurrenceExecutions')
const getJobIdsBySource = spyOn(db, 'getJobIdsBySource')
const createSchedule = spyOn(scheduler, 'createSchedule')
const deleteSchedule = spyOn(scheduler, 'deleteSchedule')

const jobDefinitions = {
  sendEmail: {
    maxRetryAttempts: 3,
    failureStrategy: { action: 'cancel' as const, alert: true },
  },
}

describe('createJobScheduler', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    dbCreateJob.mockResolvedValue(undefined)
    getJobById.mockResolvedValue(null)
    getJobErrors.mockResolvedValue([])
    getExecutions.mockResolvedValue([])
    getLatestExecutions.mockResolvedValue([])
    getOccurrenceExecutions.mockResolvedValue([])
    getJobIdsBySource.mockResolvedValue([])
    createSchedule.mockResolvedValue(undefined)
    deleteSchedule.mockResolvedValue(undefined)
  })

  test('returns object with all methods of the public API', () => {
    const jobs = createJobScheduler(jobDefinitions)

    expect(jobs).toHaveProperty('createJob')
    expect(jobs).toHaveProperty('cancelJob')
    expect(jobs).toHaveProperty('getJob')
    expect(jobs).toHaveProperty('getJobIdsBySource')
    expect(jobs).toHaveProperty('getJobErrors')
    expect(jobs).toHaveProperty('getJobExecutions')
    expect(jobs).toHaveProperty('getLatestExecutions')
    expect(jobs).toHaveProperty('getOccurrenceExecutions')
  })

  test('createJob delegates to the service with jobDefinitions', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const id = await jobs.createJob('sendEmail', 'api', { to: 'a@b.com' })

    expect(typeof id).toBe('string')
    expect(dbCreateJob).toHaveBeenCalledTimes(1)
    expect(createSchedule).toHaveBeenCalledTimes(1)
  })

  test('cancelJob delegates to the service', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const result = await jobs.cancelJob('job-1')

    expect(result).toBe(false)
    expect(getJobById).toHaveBeenCalledWith('job-1')
  })

  test('getJob delegates to db.getJobById', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const result = await jobs.getJob('job-1')

    expect(result).toBeNull()
    expect(getJobById).toHaveBeenCalledWith('job-1')
  })

  test('getJobIdsBySource delegates to db.getJobIdsBySource', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const result = await jobs.getJobIdsBySource('api', 'sendEmail')

    expect(result).toEqual([])
    expect(getJobIdsBySource).toHaveBeenCalledWith('api', 'sendEmail')
  })

  test('getJobErrors delegates to db.getJobErrors', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const result = await jobs.getJobErrors('job-1')

    expect(result).toEqual([])
    expect(getJobErrors).toHaveBeenCalledWith('job-1')
  })

  test('getJobExecutions delegates to db.getExecutions', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    const result = await jobs.getJobExecutions('job-1')

    expect(result).toEqual([])
    expect(getExecutions).toHaveBeenCalledWith('job-1')
  })

  test('getLatestExecutions uses a default limit when not given', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    await jobs.getLatestExecutions('job-1')

    // Without a default limit, the "efficient" query of the public API would have the
    // same unlimited cost it exists to avoid.
    expect(getLatestExecutions).toHaveBeenCalledWith('job-1', 20)
  })

  test('getLatestExecutions respects the given limit', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    await jobs.getLatestExecutions('job-1', 5)

    expect(getLatestExecutions).toHaveBeenCalledWith('job-1', 5)
  })

  test('getOccurrenceExecutions queries scoped to the scheduledTime', async () => {
    const jobs = createJobScheduler(jobDefinitions)
    await jobs.getOccurrenceExecutions('job-1', '2026-01-01T00:00:00Z')

    expect(getOccurrenceExecutions).toHaveBeenCalledWith(
      'job-1',
      '2026-01-01T00:00:00Z'
    )
  })
})

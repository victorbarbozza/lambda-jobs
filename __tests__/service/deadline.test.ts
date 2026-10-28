import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { DEADLINE_TOLERANCE_SECONDS } from '../../src/config.js'
import type { Job, JobExecution } from '../../src/types/job.js'
import { applyJobsTestEnv } from '../helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../../src/db/entities.js')
const { deadlineFor, deliveryTolerance, nextOccurrenceDeadline } = await import(
  '../../src/service/deadline.js'
)

const getLatestExecutions = spyOn(db, 'getLatestExecutions')

const makeJob = (
  schedule: Job['schedule'],
  overrides: Partial<Job> = {}
): Job => ({
  id: 'job-1',
  name: 'sendEmail',
  jobSource: 'api',
  status: 'active',
  schedule,
  payload: {},
  maxRetryAttempts: 0,
  failureStrategy: { action: 'continue', alert: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const makeExecution = (scheduledTime: string): JobExecution => ({
  scheduledTime,
  status: 'completed',
  attempt: 1,
  startedAt: 0,
  expiresAt: 0,
})

describe('deadlineFor', () => {
  test('adds the default tolerance to the expected instant', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z')

    expect(deadlineFor(base)).toBe(
      new Date(base + DEADLINE_TOLERANCE_SECONDS * 1000).toISOString()
    )
  })

  test('accepts custom tolerance', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z')

    expect(deadlineFor(base, 60)).toBe('2026-01-01T00:01:00.000Z')
  })
})

describe('deliveryTolerance', () => {
  test('with nothing given uses the default tolerance', () => {
    expect(deliveryTolerance()).toBe(DEADLINE_TOLERANCE_SECONDS)
  })

  test('adds the flexible window to the tolerance', () => {
    // The Scheduler is allowed to deliver up to 15 min after the nominal time:
    // enforcing before that would flag as late a job within what was agreed.
    expect(deliveryTolerance(60, 15)).toBe(60 + 15 * 60)
  })

  test('flexible window alone still adds the default tolerance', () => {
    expect(deliveryTolerance(undefined, 10)).toBe(DEADLINE_TOLERANCE_SECONDS + 600)
  })
})

describe('nextOccurrenceDeadline', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    getLatestExecutions.mockResolvedValue([])
  })

  test('one-off job has no next occurrence', async () => {
    const job = makeJob({ delay: { value: 5, unit: 'minutes' } })

    expect(await nextOccurrenceDeadline(job)).toBeUndefined()
  })

  test('rate derives the interval from the definition itself, without querying the history', async () => {
    const job = makeJob({ rate: { value: 1, unit: 'hours' } })

    const deadline = Date.parse((await nextOccurrenceDeadline(job))!)
    const expected = Date.now() + 3_600_000 + DEADLINE_TOLERANCE_SECONDS * 1000

    expect(Math.abs(deadline - expected)).toBeLessThan(5_000)
    // With `rate` the history is not used: querying would be pure cost, and on an old
    // recurring job it is the cost that grows the most.
    expect(getLatestExecutions).not.toHaveBeenCalled()
  })

  test('cron infers the interval from the last two occurrences', async () => {
    const job = makeJob({ cron: '0 * * * ? *' })
    getLatestExecutions.mockResolvedValue([
      makeExecution('2026-01-01T00:00:00.000Z'),
      makeExecution('2026-01-01T01:00:00.000Z'),
    ])

    const deadline = Date.parse((await nextOccurrenceDeadline(job))!)
    const expected = Date.now() + 3_600_000 + DEADLINE_TOLERANCE_SECONDS * 1000

    expect(Math.abs(deadline - expected)).toBeLessThan(5_000)
  })

  test('cron queries only the recent attempts, with the worst-case limit', async () => {
    const job = makeJob({ cron: '0 * * * ? *' }, { maxRetryAttempts: 3 })

    await nextOccurrenceDeadline(job)

    // The newest occurrence may take `maxRetryAttempts + 1` records before the
    // previous one shows up, because the key is `scheduledTime#attempt`.
    expect(getLatestExecutions).toHaveBeenCalledWith('job-1', 8)
  })

  test('flexible window of the job goes into the next occurrence deadline', async () => {
    const job = makeJob(
      { rate: { value: 1, unit: 'hours' } },
      { flexibleWindowMinutes: 15 }
    )

    const deadline = Date.parse((await nextOccurrenceDeadline(job))!)
    const expected =
      Date.now() + 3_600_000 + (DEADLINE_TOLERANCE_SECONDS + 15 * 60) * 1000

    expect(Math.abs(deadline - expected)).toBeLessThan(5_000)
  })

  test('cron with a single occurrence does not allow inferring yet', async () => {
    const job = makeJob({ cron: '0 * * * ? *' })
    getLatestExecutions.mockResolvedValue([
      makeExecution('2026-01-01T00:00:00.000Z'),
    ])

    expect(await nextOccurrenceDeadline(job)).toBeUndefined()
  })

  test('out-of-order occurrences do not produce a negative interval', async () => {
    const job = makeJob({ cron: '0 * * * ? *' })
    getLatestExecutions.mockResolvedValue([
      makeExecution('2026-01-01T01:00:00.000Z'),
      makeExecution('2026-01-01T00:00:00.000Z'),
    ])

    // The sorting is descending by instant, so the interval is never negative even if
    // the delivery arrives out of order.
    const deadline = await nextOccurrenceDeadline(job)
    expect(new Date(deadline!).getTime()).toBeGreaterThan(Date.now())
  })

  test('attempts of the same occurrence do not count as cadence', async () => {
    const job = makeJob({ cron: '0 * * * ? *' })
    getLatestExecutions.mockResolvedValue([
      makeExecution('2026-01-01T00:00:00.000Z'),
      makeExecution('2026-01-01T00:00:00.000Z'),
    ])

    expect(await nextOccurrenceDeadline(job)).toBeUndefined()
  })
})

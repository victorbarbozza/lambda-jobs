import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { JobsConfig } from '../src/types/config.js'
import { getJobsConfig } from '../src/utils/jobsConfig.js'
import { applyJobsTestEnv } from './helpers/jobsEnv.js'

applyJobsTestEnv()

const db = await import('../src/db/entities.js')
const scheduler = await import('../src/connectors/eventBridgeScheduler.js')
const { createJobScheduler } = await import('../src/index.js')

const jobDefinitions = {
  sendEmail: {
    maxRetryAttempts: 3,
    failureStrategy: { action: 'cancel' as const, alert: true },
  },
}

const makeJobs = (config?: JobsConfig) => createJobScheduler(jobDefinitions, config)
type Jobs = ReturnType<typeof makeJobs>

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Table seen by each db or scheduler call, read after an await as in a real query. */
const seenTables: string[] = []

const recordTable = async (): Promise<void> => {
  await wait(1)
  seenTables.push(getJobsConfig().tableName ?? 'none')
}

spyOn(db, 'createJob').mockImplementation(recordTable)
spyOn(db, 'deleteJob').mockImplementation(recordTable)
const getJobById = spyOn(db, 'getJobById')
spyOn(db, 'getJobIdsBySource').mockImplementation(async () => {
  await recordTable()
  return []
})
spyOn(db, 'getJobErrors').mockImplementation(async () => {
  await recordTable()
  return []
})
spyOn(db, 'getExecutions').mockImplementation(async () => {
  await recordTable()
  return []
})
spyOn(db, 'getLatestExecutions').mockImplementation(async () => {
  await recordTable()
  return []
})
spyOn(db, 'getOccurrenceExecutions').mockImplementation(async () => {
  await recordTable()
  return []
})
spyOn(db, 'getOverdueJobs').mockImplementation(async () => {
  await recordTable()
  return { items: [] }
})
const createSchedule = spyOn(scheduler, 'createSchedule').mockImplementation(
  recordTable
)
spyOn(scheduler, 'deleteSchedule').mockImplementation(recordTable)

const operations: Record<string, (jobs: Jobs) => Promise<unknown>> = {
  createJob: (jobs) => jobs.createJob('sendEmail', 'api', { to: 'a@b.com' }),
  cancelJob: (jobs) => jobs.cancelJob('job-1'),
  retryNow: (jobs) => jobs.retryNow('job-1'),
  getJob: (jobs) => jobs.getJob('job-1'),
  getJobIdsBySource: (jobs) => jobs.getJobIdsBySource('api', 'sendEmail'),
  getJobErrors: (jobs) => jobs.getJobErrors('job-1'),
  getJobExecutions: (jobs) => jobs.getJobExecutions('job-1'),
  getLatestExecutions: (jobs) => jobs.getLatestExecutions('job-1'),
  getOccurrenceExecutions: (jobs) =>
    jobs.getOccurrenceExecutions('job-1', '2026-01-01T00:00:00Z'),
  diagnose: (jobs) => jobs.diagnose(),
}

describe('createJobScheduler: config', () => {
  beforeEach(() => {
    seenTables.length = 0
    getJobById.mockImplementation(async () => {
      await recordTable()
      return null
    })
  })

  test.each(Object.keys(operations))(
    '%s runs with the config of its scheduler',
    async (name) => {
      await operations[name]!(makeJobs({ tableName: 'table-a' }))

      expect(seenTables.length).toBeGreaterThan(0)
      expect(seenTables.every((table) => table === 'table-a')).toBe(true)
    }
  )

  test('the whole config reaches the scheduler', async () => {
    const config: JobsConfig = {
      tableName: 'table-a',
      scheduleGroup: 'group-a',
      schedulerRoleArn: 'arn:aws:iam::123456789012:role/role-a',
      functionArn: (jobName) =>
        `arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-${jobName}`,
      region: 'eu-west-1',
    }
    let seenConfig: unknown
    createSchedule.mockImplementationOnce(async () => {
      await wait(1)
      seenConfig = getJobsConfig()
    })

    await makeJobs(config).createJob('sendEmail', 'api')

    expect(seenConfig).toEqual(config)
  })

  test('two schedulers running at the same time keep their own config', async () => {
    const seen: string[] = []
    getJobById.mockImplementation(async (id: string) => {
      await wait(id.endsWith('1') ? 5 : 1)
      seen.push(`${id}:${getJobsConfig().tableName}`)
      return null
    })

    const a = makeJobs({ tableName: 'table-a' })
    const b = makeJobs({ tableName: 'table-b' })

    await Promise.all([
      a.getJob('a-1'),
      b.getJob('b-1'),
      a.getJob('a-2'),
      b.getJob('b-2'),
    ])

    expect(seen.sort()).toEqual([
      'a-1:table-a',
      'a-2:table-a',
      'b-1:table-b',
      'b-2:table-b',
    ])
  })

  test('all operations of two schedulers at the same time', async () => {
    const a = makeJobs({ tableName: 'table-a' })
    const b = makeJobs({ tableName: 'table-b' })

    await Promise.all(Object.values(operations).flatMap((run) => [run(a), run(b)]))

    const count = (table: string) => seenTables.filter((t) => t === table).length
    expect(count('table-a')).toBeGreaterThan(0)
    expect(count('table-a')).toBe(count('table-b'))
    expect(count('table-a') + count('table-b')).toBe(seenTables.length)
  })

  test('scheduler without config: env fallback', async () => {
    await makeJobs().getJobIdsBySource('api')

    expect(seenTables).toEqual(['jobs-test-table'])
  })

  test('outside the schedulers: env fallback', async () => {
    await makeJobs({ tableName: 'table-a' }).getJobIdsBySource('api')

    expect(getJobsConfig().tableName).toBe('jobs-test-table')
  })
})

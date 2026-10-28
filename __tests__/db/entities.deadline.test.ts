import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { graphCommands, registerGraphMock } from '../helpers/graphMock.js'
import { importFresh } from '../helpers/importFresh.js'
import type { JobInput } from '../../src/types/job.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'

registerGraphMock()
applyJobsTestEnv()

const getEntities = () =>
  importFresh<typeof import('../../src/db/entities.js')>('../../src/db/entities.js')

const makeJobInput = (overrides: Partial<JobInput> = {}): JobInput => ({
  id: 'sendEmail#uuid-1',
  name: 'sendEmail',
  jobSource: 'user#123',
  status: 'scheduled',
  schedule: { delay: { value: 5, unit: 'minutes' } },
  payload: { to: 'a@b.com' },
  maxRetryAttempts: 3,
  failureStrategy: { action: 'continue', alert: false },
  ...overrides,
})

describe('db/entities — deadline relation', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    applyJobsTestEnv()

    graphCommands.createEntityTransactBatch.mockReturnValue({ Put: 'entity' })
    graphCommands.createRelationTransactBatch.mockReturnValue({ Put: 'relation' })
    graphCommands.queryRelationsInRange.mockResolvedValue({ items: [] })
    graphCommands.sendCommandTransactWriteBatch.mockResolvedValue({})
    graphCommands.deleteEntity.mockResolvedValue({})
    graphCommands.deleteRelation.mockResolvedValue({})
  })

  afterAll(() => {
    clearJobsTestEnv()
    mock.restore()
  })

  test('createJob with nextDeadline also opens the deadline relation, in the same transaction', async () => {
    const { createJob } = await getEntities()

    await createJob(makeJobInput({ nextDeadline: '2026-01-01T10:05:00.000Z' }))

    expect(graphCommands.createRelationTransactBatch).toHaveBeenCalledWith(
      'PendingJob',
      'open',
      'Deadline',
      '2026-01-01T10:05:00.000Z#sendEmail#uuid-1'
    )
    expect(graphCommands.sendCommandTransactWriteBatch).toHaveBeenCalledTimes(1)
    expect(graphCommands.sendCommandTransactWriteBatch.mock.calls[0]![0]).toHaveLength(3)
  })

  test('getOverdueJobs queries the open deadlines up to the instant, with limit and token', async () => {
    const { getOverdueJobs } = await getEntities()
    const token = { source: { S: 'PendingJob#open' } }

    await getOverdueJobs('2026-01-01T10:00:00.000Z', 50, token)

    expect(graphCommands.queryRelationsInRange).toHaveBeenCalledWith(
      'PendingJob',
      'open',
      { to: 'Deadline#2026-01-01T10:00:00.000Z' },
      { limit: 50, nextPageToken: token }
    )
  })

  test('getOverdueJobs splits the deadline from a job id that has #', async () => {
    graphCommands.queryRelationsInRange.mockResolvedValue({
      items: [
        {
          source: 'PendingJob#open',
          target: 'Deadline#2026-01-01T10:00:00.000Z#sendEmail#uuid-1',
        },
      ],
      nextPageToken: { source: { S: 'next' } },
    })
    const { getOverdueJobs } = await getEntities()

    const page = await getOverdueJobs('2026-01-01T11:00:00.000Z', 50)

    expect(page.items).toEqual([
      { deadline: '2026-01-01T10:00:00.000Z', jobId: 'sendEmail#uuid-1' },
    ])
    expect(page.nextPageToken).toEqual({ source: { S: 'next' } })
  })

  test('deleteJob with deadline also clears the deadline relation', async () => {
    const { deleteJob } = await getEntities()

    await deleteJob('sendEmail#uuid-1', 'user#123', '2026-01-01T10:05:00.000Z')

    expect(graphCommands.deleteRelation).toHaveBeenCalledWith(
      'PendingJob',
      'open',
      'Deadline',
      '2026-01-01T10:05:00.000Z#sendEmail#uuid-1'
    )
  })
})

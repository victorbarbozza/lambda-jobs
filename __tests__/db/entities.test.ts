import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import { graphCommands, registerGraphMock } from '../helpers/graphMock.js'
import { importFresh } from '../helpers/importFresh.js'
import type { JobExecution, JobInput } from '../../src/types/job.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'

registerGraphMock()
applyJobsTestEnv()

/**
 * Each test uses its own instance of the module: the other test files
 * `spyOn` the exports of `entities`, and a shared instance would be
 * replaced by those spies depending on the execution order.
 */
const getEntities = () =>
  importFresh<typeof import('../../src/db/entities.js')>('../../src/db/entities.js')

const notFound = () =>
  new ConditionalCheckFailedException({
    message: 'The conditional request failed',
    $metadata: {},
  })

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

const makeExecution = (overrides: Partial<JobExecution> = {}): JobExecution => ({
  scheduledTime: '2026-01-01T10:00:00',
  status: 'running',
  attempt: 1,
  startedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_060_000,
  ...overrides,
})

describe('db/entities', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    applyJobsTestEnv()

    graphCommands.createEntityTransactBatch.mockReturnValue({ Put: 'entity' })
    graphCommands.createRelationTransactBatch.mockReturnValue({ Put: 'relation' })
    graphCommands.deleteRelationTransactBatch.mockReturnValue({ Delete: 'relation' })
    graphCommands.queryRelationsInRange.mockResolvedValue({ items: [] })
    graphCommands.sendCommandTransactWriteBatch.mockResolvedValue({})
    graphCommands.updateEntityField.mockResolvedValue({})
    graphCommands.upsertRelationField.mockResolvedValue({})
    graphCommands.getAllRelationsWhithPrefix.mockResolvedValue([])
    graphCommands.deleteEntity.mockResolvedValue({})
    graphCommands.deleteRelation.mockResolvedValue({})
  })

  afterAll(() => {
    clearJobsTestEnv()
    mock.restore()
  })

  describe('createJob', () => {
    test('writes the job and the JobSource -> Job relation in the same transaction', async () => {
      const { createJob } = await getEntities()
      const job = makeJobInput()

      await createJob(job)

      expect(graphCommands.createEntityTransactBatch).toHaveBeenCalledWith(
        'Job',
        job.id,
        job
      )
      expect(graphCommands.createRelationTransactBatch).toHaveBeenCalledWith(
        'JobSource',
        job.jobSource,
        'Job',
        job.id
      )
      expect(graphCommands.sendCommandTransactWriteBatch).toHaveBeenCalledWith([
        { Put: 'entity' },
        { Put: 'relation' },
      ])
    })
  })

  describe('moveDeadline', () => {
    test('updates the job partially, never rewriting the whole entity', async () => {
      const { moveDeadline } = await getEntities()

      await moveDeadline('sendEmail#uuid-1', 'before', 'after', { status: 'active' })

      // Writing the entity here would erase schedule, payload and failureStrategy:
      // everything not in `fields` would disappear from the job.
      expect(graphCommands.createEntityTransactBatch).not.toHaveBeenCalled()
      expect(graphCommands.updateEntityField).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        { status: 'active', nextDeadline: 'after' },
        []
      )
    })

    test('deletes the previous deadline and creates the new one in the same transaction', async () => {
      const { moveDeadline } = await getEntities()

      await moveDeadline('sendEmail#uuid-1', 'before', 'after', {})

      expect(graphCommands.deleteRelationTransactBatch).toHaveBeenCalledWith(
        'PendingJob',
        'open',
        'Deadline',
        'before#sendEmail#uuid-1'
      )
      expect(graphCommands.createRelationTransactBatch).toHaveBeenCalledWith(
        'PendingJob',
        'open',
        'Deadline',
        'after#sendEmail#uuid-1'
      )
      expect(graphCommands.sendCommandTransactWriteBatch).toHaveBeenCalledWith([
        { Delete: 'relation' },
        { Put: 'relation' },
      ])
    })

    test('field without value is removed by name, not ignored', async () => {
      const { moveDeadline } = await getEntities()

      await moveDeadline('sendEmail#uuid-1', 'before', undefined, {
        status: 'completed',
        nextRetryAt: undefined,
      })

      // The partial update ignores a key with value `undefined`: without asking for the
      // removal, the deadline and the pending retry would stay stored.
      expect(graphCommands.updateEntityField).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        { status: 'completed' },
        ['nextRetryAt', 'nextDeadline']
      )
    })

    test('no deadline on either side: does not open a transaction', async () => {
      const { moveDeadline } = await getEntities()

      await moveDeadline('sendEmail#uuid-1', undefined, undefined, { status: 'failed' })

      expect(graphCommands.sendCommandTransactWriteBatch).not.toHaveBeenCalled()
      expect(graphCommands.updateEntityField).toHaveBeenCalled()
    })
  })

  describe('getJobById', () => {
    test('removes the graph fields from the result', async () => {
      const job = makeJobInput()
      graphCommands.getEntity.mockResolvedValue({
        ...job,
        source: 'Job#sendEmail#uuid-1',
        target: 'Job#sendEmail#uuid-1',
        relation: 'Job',
      })

      const { getJobById } = await getEntities()
      const result = await getJobById(job.id)

      expect(result as unknown).toEqual(job)
    })

    test('missing entity: returns null', async () => {
      graphCommands.getEntity.mockResolvedValue(null)

      const { getJobById } = await getEntities()

      expect(await getJobById('sendEmail#uuid-1')).toBeNull()
    })

    test('infra error: propagates', async () => {
      graphCommands.getEntity.mockRejectedValue(new Error('DynamoDB down'))

      const { getJobById } = await getEntities()

      await expect(getJobById('sendEmail#uuid-1')).rejects.toThrow('DynamoDB down')
    })
  })

  describe('getJobErrors', () => {
    test('returns only executions with error, in the JobErrorRecord format', async () => {
      graphCommands.getAllRelationsWhithPrefix.mockResolvedValue([
        makeExecution({ attempt: 1, status: 'completed' }),
        makeExecution({
          attempt: 2,
          status: 'failed',
          error: { message: 'timeout', code: 'ETIMEDOUT', stack: 'stack' },
        }),
      ])

      const { getJobErrors } = await getEntities()
      const errors = await getJobErrors('sendEmail#uuid-1')

      expect(errors).toEqual([
        {
          jobId: 'sendEmail#uuid-1',
          attempt: 2,
          scheduledTime: '2026-01-01T10:00:00',
          message: 'timeout',
          code: 'ETIMEDOUT',
          stack: 'stack',
        },
      ])
    })

    test('queries all executions of the job by prefix', async () => {
      const { getJobErrors } = await getEntities()

      await getJobErrors('sendEmail#uuid-1')

      expect(graphCommands.getAllRelationsWhithPrefix).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#'
      )
    })
  })

  describe('upsertExecution', () => {
    test('uses scheduledTime#attempt as the relation key', async () => {
      const { upsertExecution } = await getEntities()
      const execution = makeExecution({ attempt: 3 })

      await upsertExecution('sendEmail#uuid-1', execution)

      expect(graphCommands.upsertRelationField).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution',
        '2026-01-01T10:00:00#0003',
        expect.objectContaining({ attempt: 3 })
      )
    })
  })

  describe('getExecutions', () => {
    test('lists the whole job history and removes graph fields', async () => {
      const execution = makeExecution({ attempt: 1 })
      graphCommands.getAllRelationsWhithPrefix.mockResolvedValue([
        {
          ...execution,
          source: 'Job#sendEmail#uuid-1',
          target: 'JobExecution#2026-01-01T10:00:00#1',
          relation: 'JobExecution',
        },
      ])

      const { getExecutions } = await getEntities()
      const result = await getExecutions('sendEmail#uuid-1')

      expect(graphCommands.getAllRelationsWhithPrefix).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#'
      )
      expect(result).toEqual([execution])
    })
  })

  describe('getOccurrenceExecutions', () => {
    test('queries by the occurrence prefix and sorts by attempt', async () => {
      graphCommands.getAllRelationsWhithPrefix.mockResolvedValue([
        makeExecution({ attempt: 2 }),
        makeExecution({ attempt: 1 }),
      ])

      const { getOccurrenceExecutions } = await getEntities()
      const result = await getOccurrenceExecutions(
        'sendEmail#uuid-1',
        '2026-01-01T10:00:00'
      )

      expect(graphCommands.getAllRelationsWhithPrefix).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#2026-01-01T10:00:00#'
      )
      expect(result.map((e) => e.attempt)).toEqual([1, 2])
    })
  })

  describe('getLatestExecutions', () => {
    test('queries one page in descending order, with limit', async () => {
      const { getLatestExecutions } = await getEntities()

      await getLatestExecutions('sendEmail#uuid-1', 8)

      // A single descending page: whoever needs the recent occurrences cannot
      // pay for the whole history of an old recurring job.
      expect(graphCommands.queryRelationsInRange).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1',
        { from: 'JobExecution#', to: 'JobExecution#￿' },
        { limit: 8, ascending: false }
      )
    })

    test('removes the graph fields from the result', async () => {
      const execution = makeExecution({ attempt: 2 })
      graphCommands.queryRelationsInRange.mockResolvedValue({
        items: [
          {
            ...execution,
            source: 'Job#sendEmail#uuid-1',
            target: 'JobExecution#2026-01-01T10:00:00#0002',
            relation: 'JobExecution',
          },
        ],
      })

      const { getLatestExecutions } = await getEntities()

      expect(await getLatestExecutions('sendEmail#uuid-1', 4)).toEqual([execution])
    })
  })

  describe('getJobIdsBySource', () => {
    test('without name: queries all jobs of the source', async () => {
      const { getJobIdsBySource } = await getEntities()

      await getJobIdsBySource('user#123')

      expect(graphCommands.getAllRelationsWhithPrefix).toHaveBeenCalledWith(
        'JobSource',
        'user#123',
        'Job#'
      )
    })

    test('with name: restricts the prefix to the job type', async () => {
      const { getJobIdsBySource } = await getEntities()

      const result = await getJobIdsBySource('user#123', 'sendEmail')

      expect(graphCommands.getAllRelationsWhithPrefix).toHaveBeenCalledWith(
        'JobSource',
        'user#123',
        'Job#sendEmail#'
      )
      expect(result).toEqual(['sendEmail#uuid-1'])
    })
  })

  describe('deleteJob', () => {
    test('removes the entity and the relation with the source', async () => {
      const { deleteJob } = await getEntities()

      await deleteJob('sendEmail#uuid-1', 'user#123')

      expect(graphCommands.deleteRelation).toHaveBeenCalledWith(
        'JobSource',
        'user#123',
        'Job',
        'sendEmail#uuid-1'
      )
      expect(graphCommands.deleteEntity).toHaveBeenCalledWith(
        'Job',
        'sendEmail#uuid-1'
      )
    })

    test('resources already missing: does not fail', async () => {
      graphCommands.deleteRelation.mockRejectedValue(notFound())
      graphCommands.deleteEntity.mockRejectedValue(notFound())

      const { deleteJob } = await getEntities()

      await expect(
        deleteJob('sendEmail#uuid-1', 'user#123')
      ).resolves.toBeUndefined()
    })

    test('infra error: propagates', async () => {
      graphCommands.deleteEntity.mockRejectedValue(new Error('DynamoDB down'))

      const { deleteJob } = await getEntities()

      await expect(deleteJob('sendEmail#uuid-1', 'user#123')).rejects.toThrow(
        'DynamoDB down'
      )
    })
  })

  describe('clearDeadline', () => {
    test('removes only the deadline relation, without touching the job', async () => {
      const { clearDeadline } = await getEntities()

      await clearDeadline('sendEmail#uuid-1', 'before')

      expect(graphCommands.deleteRelation).toHaveBeenCalledWith(
        'PendingJob',
        'open',
        'Deadline',
        'before#sendEmail#uuid-1'
      )
      expect(graphCommands.updateEntityField).not.toHaveBeenCalled()
    })

    test('deadline already missing: does not fail', async () => {
      graphCommands.deleteRelation.mockRejectedValue(notFound())

      const { clearDeadline } = await getEntities()

      await expect(
        clearDeadline('sendEmail#uuid-1', 'before')
      ).resolves.toBeUndefined()
    })
  })
})

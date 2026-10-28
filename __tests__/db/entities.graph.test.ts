import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { graphCommands, registerGraphMock } from '../helpers/graphMock.js'
import { importFresh } from '../helpers/importFresh.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'

registerGraphMock()
applyJobsTestEnv()

const getEntities = () =>
  importFresh<typeof import('../../src/db/entities.js')>('../../src/db/entities.js')

/** Same `name` as the SDK error, from another copy of the SDK where `instanceof` fails. */
const conditionFailure = () =>
  Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  })

describe('db/entities — graph layer', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    applyJobsTestEnv()

    graphCommands.deleteEntity.mockResolvedValue({})
    graphCommands.deleteRelation.mockResolvedValue({})
  })

  afterAll(() => {
    clearJobsTestEnv()
    mock.restore()
  })

  test('getJobById keeps createdAt and updatedAt, which are part of Job', async () => {
    graphCommands.getEntity.mockResolvedValue({
      id: 'sendEmail#uuid-1',
      source: 'Job#sendEmail#uuid-1',
      target: 'Job#sendEmail#uuid-1',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:05:00.000Z',
    })
    const { getJobById } = await getEntities()

    const job = await getJobById('sendEmail#uuid-1')

    expect(job).toEqual({
      id: 'sendEmail#uuid-1',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:05:00.000Z',
    } as never)
  })

  test('"not found" comes from the error type: condition failure by name is ignored', async () => {
    graphCommands.deleteEntity.mockRejectedValue(conditionFailure())
    graphCommands.deleteRelation.mockRejectedValue(conditionFailure())
    const { deleteJob } = await getEntities()

    await expect(
      deleteJob('sendEmail#uuid-1', 'user#123', '2026-01-01T10:05:00.000Z')
    ).resolves.toBeUndefined()
  })

  test('"not found" in the message of another error is not ignored', async () => {
    graphCommands.deleteEntity.mockRejectedValue(new Error('table not found'))
    const { deleteJob } = await getEntities()

    await expect(deleteJob('sendEmail#uuid-1', 'user#123')).rejects.toThrow(
      'table not found'
    )
  })

  test('clearDeadline: infra error propagates', async () => {
    graphCommands.deleteRelation.mockRejectedValue(new Error('throttled'))
    const { clearDeadline } = await getEntities()

    await expect(
      clearDeadline('sendEmail#uuid-1', '2026-01-01T10:05:00.000Z')
    ).rejects.toThrow('throttled')
  })
})

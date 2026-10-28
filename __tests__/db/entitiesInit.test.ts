import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRawGraphCommands, registerGraphMock } from '../helpers/graphMock.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'
import { importFresh } from '../helpers/importFresh.js'

registerGraphMock()

/**
 * Each test here needs a freshly evaluated module, because the subject is
 * precisely when the graph client is resolved for the first time.
 */
const getFreshEntities = () =>
  importFresh<typeof import('../../src/db/entities.js')>('../../src/db/entities.js')

describe('db/entities — client resolution', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    applyJobsTestEnv()
  })

  afterAll(() => {
    clearJobsTestEnv()
  })

  test('module import does not create the graph client', async () => {
    await getFreshEntities()

    expect(createRawGraphCommands).not.toHaveBeenCalled()
  })

  test('first query creates the client with table and region from env', async () => {
    const { getJobIdsBySource } = await getFreshEntities()

    await getJobIdsBySource('user#123')

    expect(createRawGraphCommands).toHaveBeenCalledWith('jobs-test-table', {
      region: 'us-east-1',
    })
  })

  test('client is reused between queries', async () => {
    const { getJobIdsBySource } = await getFreshEntities()

    await getJobIdsBySource('user#123')
    await getJobIdsBySource('user#456')

    expect(createRawGraphCommands).toHaveBeenCalledTimes(1)
  })

  test('without JOB_TABLE_NAME: first query throws JobConfigError', async () => {
    const { getJobIdsBySource } = await getFreshEntities()
    delete process.env.JOB_TABLE_NAME

    await expect(getJobIdsBySource('user#123')).rejects.toHaveProperty(
      'code',
      'ERR_JOB_CONFIG'
    )
  })
})

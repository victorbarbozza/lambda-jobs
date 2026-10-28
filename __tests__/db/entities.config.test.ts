import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createRawGraphCommands, registerGraphMock } from '../helpers/graphMock.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'
import { importFresh } from '../helpers/importFresh.js'
import { JobConfigError } from '../../src/utils/errors.js'
import { runInScope } from '../../src/utils/scope.js'
import type { JobsConfig } from '../../src/types/config.js'

registerGraphMock()

/** Fresh module per test, so the graph cache starts empty. */
const getFreshEntities = () =>
  importFresh<typeof import('../../src/db/entities.js')>('../../src/db/entities.js')

describe('db/entities: config from the scope', () => {
  beforeEach(() => {
    mock.clearAllMocks()
    applyJobsTestEnv()
  })

  afterAll(() => {
    clearJobsTestEnv()
  })

  const queryIn = async (config: JobsConfig) => {
    const { getJobIdsBySource } = await getFreshEntities()
    return runInScope({ config }, () => getJobIdsBySource('user#123'))
  }

  test('tableName and region from the scope config win over the env', async () => {
    await queryIn({ tableName: 'scoped-table', region: 'eu-west-1' })

    expect(createRawGraphCommands).toHaveBeenCalledWith('scoped-table', {
      region: 'eu-west-1',
    })
  })

  test('tableName from the scope config works without JOB_TABLE_NAME', async () => {
    delete process.env.JOB_TABLE_NAME

    await queryIn({ tableName: 'scoped-table' })

    expect(createRawGraphCommands).toHaveBeenCalledWith('scoped-table', {
      region: 'us-east-1',
    })
  })

  test('one graph per region and table', async () => {
    const { getJobIdsBySource } = await getFreshEntities()
    const inScope = (config: JobsConfig) =>
      runInScope({ config }, () => getJobIdsBySource('user#123'))

    await inScope({ tableName: 'table-a' })
    await inScope({ tableName: 'table-b' })
    await inScope({ tableName: 'table-a', region: 'eu-west-1' })
    await inScope({ tableName: 'table-a' })
    await inScope({ tableName: 'table-b' })
    await inScope({ tableName: 'table-a', region: 'eu-west-1' })

    expect(createRawGraphCommands.mock.calls as unknown[]).toEqual([
      ['table-a', { region: 'us-east-1' }],
      ['table-b', { region: 'us-east-1' }],
      ['table-a', { region: 'eu-west-1' }],
    ])
  })

  test('without tableName in the config or JOB_TABLE_NAME: JobConfigError', async () => {
    delete process.env.JOB_TABLE_NAME

    const query = queryIn({ region: 'eu-west-1' })

    await expect(query).rejects.toBeInstanceOf(JobConfigError)
    await expect(query).rejects.toThrow(
      'Jobs table not set: use tableName in the config or JOB_TABLE_NAME'
    )
    expect(createRawGraphCommands).not.toHaveBeenCalled()
  })
})

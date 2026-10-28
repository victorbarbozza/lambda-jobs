import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getJobsConfig } from '../../src/utils/jobsConfig.js'
import { runInScope } from '../../src/utils/scope.js'
import { applyJobsTestEnv, clearJobsTestEnv } from '../helpers/jobsEnv.js'

describe('getJobsConfig', () => {
  beforeEach(() => {
    clearJobsTestEnv()
    applyJobsTestEnv()
  })

  afterEach(() => {
    clearJobsTestEnv()
  })

  test('outside a scope: values from the env', () => {
    process.env.JOB_SCHEDULE_GROUP = 'jobs-group'

    expect(getJobsConfig()).toEqual({
      tableName: 'jobs-test-table',
      scheduleGroup: 'jobs-group',
      schedulerRoleArn: 'arn:aws:iam::123456789012:role/job-role',
      functionArn: undefined,
      region: 'us-east-1',
    })
  })

  test('without JOB_SCHEDULE_GROUP: scheduleGroup is default', () => {
    expect(getJobsConfig().scheduleGroup).toBe('default')
  })

  test('without config and without env: only scheduleGroup has a value', () => {
    clearJobsTestEnv()

    expect(getJobsConfig()).toEqual({
      tableName: undefined,
      scheduleGroup: 'default',
      schedulerRoleArn: undefined,
      functionArn: undefined,
      region: undefined,
    })
  })

  test('config from the scope wins over the env', () => {
    process.env.JOB_SCHEDULE_GROUP = 'jobs-group'
    const functionArn = (jobName: string) => `arn:${jobName}`

    const config = runInScope(
      {
        config: {
          tableName: 'scoped-table',
          scheduleGroup: 'scoped-group',
          schedulerRoleArn: 'arn:aws:iam::123456789012:role/scoped-role',
          functionArn,
          region: 'eu-west-1',
        },
      },
      () => getJobsConfig()
    )

    expect(config).toEqual({
      tableName: 'scoped-table',
      scheduleGroup: 'scoped-group',
      schedulerRoleArn: 'arn:aws:iam::123456789012:role/scoped-role',
      functionArn,
      region: 'eu-west-1',
    })
  })

  test('field left out of the config falls back to the env', () => {
    const config = runInScope({ config: { tableName: 'scoped-table' } }, () =>
      getJobsConfig()
    )

    expect(config).toEqual({
      tableName: 'scoped-table',
      scheduleGroup: 'default',
      schedulerRoleArn: 'arn:aws:iam::123456789012:role/job-role',
      functionArn: undefined,
      region: 'us-east-1',
    })
  })

  test('scope without config: values from the env', () => {
    const config = runInScope({ jobName: 'sendEmail' }, () => getJobsConfig())

    expect(config.tableName).toBe('jobs-test-table')
  })

  test('reads the env on each call, not on import', () => {
    process.env.JOB_TABLE_NAME = 'other-table'

    expect(getJobsConfig().tableName).toBe('other-table')
  })
})

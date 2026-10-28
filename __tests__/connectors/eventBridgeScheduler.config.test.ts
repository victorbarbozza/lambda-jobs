import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test'
import type {
  CreateRetryScheduleParams,
  CreateScheduleParams,
} from '../../src/connectors/eventBridgeScheduler.js'
import { runInScope, type JobScope } from '../../src/utils/scope.js'
import { applyJobsTestEnv, clearJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'
import { importFresh } from '../helpers/importFresh.js'

const sendMock = vi.fn().mockResolvedValue({})
const clientConfigSpy = vi.fn()
const createCommandSpy = vi.fn()
const deleteCommandSpy = vi.fn()

const registerSchedulerSdkMock = () =>
  mock.module('@aws-sdk/client-scheduler', () => ({
    SchedulerClient: class {
      send = sendMock
      constructor(config: unknown) {
        clientConfigSpy(config)
      }
    },
    CreateScheduleCommand: class {
      constructor(input: unknown) {
        createCommandSpy(input)
      }
    },
    DeleteScheduleCommand: class {
      constructor(input: unknown) {
        deleteCommandSpy(input)
      }
    },
    ResourceNotFoundException: class extends Error {},
  }))

const defaultParams: CreateScheduleParams = {
  id: 'job-1',
  jobName: 'sendEmail',
  jobSource: 'api',
  payload: { to: 'a@b.com' },
  maxRetryAttempts: 3,
  schedule: { delay: { value: 5, unit: 'minutes' } },
}

const retryParams: CreateRetryScheduleParams = {
  id: 'jobRunner#uuid-1',
  jobName: 'jobRunner',
  jobSource: 'api',
  payload: {},
  maxRetryAttempts: 3,
  scheduledTime: '2025-01-01T00:00:00Z',
  runAt: '2025-01-01T00:01:00Z',
  attempt: 2,
}

/** Scope of a Lambda running another job, from which the target ARN is derived. */
const lambdaScope: JobScope = { invokedFunctionArn: TEST_FUNCTION_ARN }

const getAdapter = async (scope: JobScope = lambdaScope) => {
  const mod = await importFresh<
    typeof import('../../src/connectors/eventBridgeScheduler.js')
  >('../../src/connectors/eventBridgeScheduler.js')

  return {
    createSchedule: (params: CreateScheduleParams) =>
      runInScope(scope, () => mod.createSchedule(params)),
    createRetrySchedule: (params: CreateRetryScheduleParams) =>
      runInScope(scope, () => mod.createRetrySchedule(params)),
    deleteSchedule: (name: string) =>
      runInScope(scope, () => mod.deleteSchedule(name)),
  }
}

type Adapter = Awaited<ReturnType<typeof getAdapter>>

const operations: [string, (adapter: Adapter) => Promise<void>][] = [
  ['createSchedule', (adapter) => adapter.createSchedule(defaultParams)],
  ['createRetrySchedule', (adapter) => adapter.createRetrySchedule(retryParams)],
  ['deleteSchedule', (adapter) => adapter.deleteSchedule('job-123')],
]

const lastCreateCmd = () =>
  createCommandSpy.mock.calls.at(-1)![0] as Record<string, unknown>

const lastTarget = () => lastCreateCmd().Target as Record<string, unknown>

describe('eventBridgeScheduler config', () => {
  beforeEach(() => {
    mock.restore()
    registerSchedulerSdkMock()
    applyJobsTestEnv()
    mock.clearAllMocks()
    sendMock.mockResolvedValue({})
  })

  afterEach(() => {
    clearJobsTestEnv()
  })

  afterAll(() => {
    mock.restore()
  })

  describe('GroupName', () => {
    test("without configuration: 'default'", async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule(defaultParams)

      expect(lastCreateCmd().GroupName).toBe('default')
    })

    test('JOB_SCHEDULE_GROUP sets the group', async () => {
      process.env.JOB_SCHEDULE_GROUP = 'orders'
      const { createSchedule } = await getAdapter()

      await createSchedule(defaultParams)

      expect(lastCreateCmd().GroupName).toBe('orders')
    })

    test('config.scheduleGroup beats JOB_SCHEDULE_GROUP', async () => {
      process.env.JOB_SCHEDULE_GROUP = 'orders'
      const { createSchedule, createRetrySchedule, deleteSchedule } = await getAdapter({
        ...lambdaScope,
        config: { scheduleGroup: 'billing' },
      })

      await createSchedule(defaultParams)
      expect(lastCreateCmd().GroupName).toBe('billing')

      await createRetrySchedule(retryParams)
      expect(lastCreateCmd().GroupName).toBe('billing')

      await deleteSchedule('job-123')
      expect(deleteCommandSpy).toHaveBeenCalledWith({
        GroupName: 'billing',
        Name: 'job-123',
      })
    })
  })

  describe('Target.Arn', () => {
    test('config.functionArn wins over the invoked Lambda', async () => {
      const functionArn = vi.fn(
        (jobName: string) => `arn:aws:lambda:us-east-1:123456789012:function:${jobName}`
      )
      const { createSchedule } = await getAdapter({
        ...lambdaScope,
        config: { functionArn },
      })

      await createSchedule(defaultParams)

      expect(functionArn).toHaveBeenCalledWith('sendEmail')
      expect(lastTarget().Arn).toBe(
        'arn:aws:lambda:us-east-1:123456789012:function:sendEmail'
      )
    })

    test('without functionArn: another job is next to the invoked Lambda', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule(defaultParams)

      expect(lastTarget().Arn).toBe(
        'arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-sendEmail'
      )
    })

    test('without functionArn: the retry of the running job goes to the invoked Lambda, unqualified', async () => {
      const { createRetrySchedule } = await getAdapter({
        invokedFunctionArn: `${TEST_FUNCTION_ARN}:live`,
        jobName: 'jobRunner',
      })

      await createRetrySchedule(retryParams)

      expect(lastTarget().Arn).toBe(TEST_FUNCTION_ARN)
      expect(lastCreateCmd().Name).toBe('jobRunner-uuid-1-r2')
    })

    test('without functionArn and outside a Lambda: JobConfigError, nothing sent', async () => {
      const { createSchedule } = await getAdapter({})

      const err = await createSchedule(defaultParams).catch((e) => e)

      expect(err).toHaveProperty('code', 'ERR_JOB_CONFIG')
      expect(err.message).toContain('functionArn')
      expect(sendMock).not.toHaveBeenCalled()
    })
  })

  describe('role and region', () => {
    test.each(operations)(
      'missing JOB_ROLE_ARN: %s throws JobConfigError',
      async (_name, run) => {
        delete process.env.JOB_ROLE_ARN
        const adapter = await getAdapter()

        await expect(run(adapter)).rejects.toHaveProperty('code', 'ERR_JOB_CONFIG')
        expect(sendMock).not.toHaveBeenCalled()
      }
    )

    test.each(operations)(
      'missing AWS_REGION: %s throws JobConfigError',
      async (_name, run) => {
        delete process.env.AWS_REGION
        const adapter = await getAdapter()

        await expect(run(adapter)).rejects.toHaveProperty('code', 'ERR_JOB_CONFIG')
        expect(sendMock).not.toHaveBeenCalled()
      }
    )

    test('config.schedulerRoleArn beats JOB_ROLE_ARN', async () => {
      const { createSchedule } = await getAdapter({
        ...lambdaScope,
        config: { schedulerRoleArn: 'arn:aws:iam::123456789012:role/from-config' },
      })

      await createSchedule(defaultParams)

      expect(lastTarget().RoleArn).toBe('arn:aws:iam::123456789012:role/from-config')
    })

    test('config.region beats AWS_REGION', async () => {
      const { createSchedule } = await getAdapter({
        ...lambdaScope,
        config: { region: 'sa-east-1' },
      })

      await createSchedule(defaultParams)

      expect(clientConfigSpy).toHaveBeenCalledWith({ region: 'sa-east-1' })
    })

    test('config role and region without env', async () => {
      delete process.env.JOB_ROLE_ARN
      delete process.env.AWS_REGION
      const { deleteSchedule } = await getAdapter({
        config: {
          schedulerRoleArn: 'arn:aws:iam::123456789012:role/from-config',
          region: 'sa-east-1',
        },
      })

      await expect(deleteSchedule('job-123')).resolves.toBeUndefined()
      expect(clientConfigSpy).toHaveBeenCalledWith({ region: 'sa-east-1' })
    })
  })
})

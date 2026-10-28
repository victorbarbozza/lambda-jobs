import { afterAll, afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test'
import type { CreateScheduleParams } from '../../src/connectors/eventBridgeScheduler.js'
import { runInScope } from '../../src/utils/scope.js'
import { applyJobsTestEnv, clearJobsTestEnv, TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'
import { importFresh } from '../helpers/importFresh.js'

const sendMock = vi.fn().mockResolvedValue({})
const createCommandSpy = vi.fn()
const deleteCommandSpy = vi.fn()

class ResourceNotFoundException extends Error {
  constructor(opts?: { message?: string; Message?: string }) {
    super(opts?.message ?? opts?.Message ?? 'not found')
    this.name = 'ResourceNotFoundException'
  }
}

const registerSchedulerSdkMock = () =>
  mock.module('@aws-sdk/client-scheduler', () => ({
    SchedulerClient: class {
      send = sendMock
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
    ResourceNotFoundException,
  }))

const defaultParams: CreateScheduleParams = {
  id: 'job-1',
  jobName: 'sendEmail',
  jobSource: 'api',
  payload: { to: 'a@b.com' },
  maxRetryAttempts: 3,
  schedule: { delay: { value: 5, unit: 'minutes' } },
}

const getAdapter = async () => {
  const mod = await importFresh<
    typeof import('../../src/connectors/eventBridgeScheduler.js')
  >('../../src/connectors/eventBridgeScheduler.js')

  return {
    // The target ARN is derived from the invoked Lambda.
    createSchedule: (params: CreateScheduleParams) =>
      runInScope({ invokedFunctionArn: TEST_FUNCTION_ARN }, () =>
        mod.createSchedule(params)
      ),
    deleteSchedule: mod.deleteSchedule,
  }
}

const createResourceNotFoundError = () =>
  new ResourceNotFoundException({
    message: 'not found',
    Message: 'not found',
  })

const lastCreateCmd = () =>
  createCommandSpy.mock.calls.at(-1)![0] as Record<string, unknown>

describe('eventBridgeScheduler', () => {
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

  describe('config validation', () => {
    const expectConfigError = async () => {
      const { createSchedule } = await getAdapter()

      await expect(createSchedule(defaultParams)).rejects.toHaveProperty(
        'code',
        'ERR_JOB_CONFIG'
      )
    }

    test('missing AWS_REGION throws JobConfigError', async () => {
      delete process.env.AWS_REGION
      await expectConfigError()
    })

    test('missing JOB_ROLE_ARN throws JobConfigError', async () => {
      delete process.env.JOB_ROLE_ARN
      await expectConfigError()
    })

    test('module import does not require AWS env', async () => {
      clearJobsTestEnv()

      await expect(getAdapter()).resolves.toHaveProperty('createSchedule')
    })
  })

  describe('createSchedule — expressions', () => {
    test('schedule delay → at(...) expression', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({
        ...defaultParams,
        schedule: { delay: { value: 10, unit: 'minutes' } },
      })

      const cmd = lastCreateCmd()
      expect(cmd.ScheduleExpression).toMatch(
        /^at\(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\)$/
      )
    })

    test('schedule at → at(...) expression', async () => {
      const { createSchedule } = await getAdapter()
      const date = '2025-06-15T10:30:00Z'

      await createSchedule({ ...defaultParams, schedule: { at: date } })

      const cmd = lastCreateCmd()
      expect(cmd.ScheduleExpression).toBe('at(2025-06-15T10:30:00)')
    })

    test('schedule cron → cron(...) expression', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({
        ...defaultParams,
        schedule: { cron: '0 12 * * ? *' },
      })

      const cmd = lastCreateCmd()
      expect(cmd.ScheduleExpression).toBe('cron(0 12 * * ? *)')
    })

    test('schedule rate → rate(...) expression', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({
        ...defaultParams,
        schedule: { rate: { value: 5, unit: 'minutes' } },
      })

      const cmd = lastCreateCmd()
      expect(cmd.ScheduleExpression).toBe('rate(5 minutes)')
    })

    test('schedule without a recognized field → JobValidationError', async () => {
      const { createSchedule } = await getAdapter()

      expect(() =>
        createSchedule({ ...defaultParams, schedule: {} as never })
      ).toThrow('ScheduleOptions must contain')
    })
  })

  describe('createSchedule — config', () => {
    test('flexibleWindowMinutes > 0 → mode FLEXIBLE', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({ ...defaultParams, flexibleWindowMinutes: 15 })

      const cmd = lastCreateCmd()
      expect(cmd.FlexibleTimeWindow).toEqual({
        Mode: 'FLEXIBLE',
        MaximumWindowInMinutes: 15,
      })
    })

    test('flexibleWindowMinutes zero → mode OFF', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({ ...defaultParams, flexibleWindowMinutes: 0 })

      const cmd = lastCreateCmd()
      expect(cmd.FlexibleTimeWindow).toEqual({ Mode: 'OFF' })
    })

    test('ActionAfterCompletion always DELETE', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule({ ...defaultParams })
      expect(lastCreateCmd().ActionAfterCompletion).toBe('DELETE')
    })

    test('lambda input contains EventBridge placeholders', async () => {
      const { createSchedule } = await getAdapter()

      await createSchedule(defaultParams)

      const target = lastCreateCmd().Target as Record<string, unknown>
      const input = JSON.parse(target.Input as string)
      expect(input.scheduledTime).toBe('<aws.scheduler.scheduled-time>')
      expect(input.attempt).toBe('<aws.scheduler.attempt-number>')
    })

    test('client.send fails → JobSchedulerError with cause', async () => {
      const awsError = new Error('AWS error')
      sendMock.mockRejectedValue(awsError)

      const { createSchedule } = await getAdapter()

      const err = await createSchedule(defaultParams).catch((e) => e)
      expect(err).toHaveProperty('code', 'ERR_JOB_SCHEDULER')
      expect(err.cause).toBe(awsError)
    })
  })

  describe('deleteSchedule', () => {
    test('calls DeleteScheduleCommand with correct GroupName and Name', async () => {
      const { deleteSchedule } = await getAdapter()

      await deleteSchedule('job-123')

      expect(deleteCommandSpy).toHaveBeenCalledWith({
        GroupName: 'default',
        Name: 'job-123',
      })
    })

    test('client.send fails → JobSchedulerError with cause', async () => {
      const awsError = new Error('not found')
      sendMock.mockRejectedValue(awsError)

      const { deleteSchedule } = await getAdapter()

      await expect(deleteSchedule('job-x')).rejects.toHaveProperty(
        'code',
        'ERR_JOB_SCHEDULER'
      )
    })

    test('nonexistent schedule: treats as success', async () => {
      sendMock.mockRejectedValue(createResourceNotFoundError())

      const { deleteSchedule } = await getAdapter()

      await expect(deleteSchedule('job-x')).resolves.toBeUndefined()
    })
  })
})

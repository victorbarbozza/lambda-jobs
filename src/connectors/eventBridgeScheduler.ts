import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
} from '@aws-sdk/client-scheduler'
import type { JobEvent } from '../types/event.js'
import type { ScheduleOptions } from '../types/schedule.js'
import {
  JobConfigError,
  JobSchedulerError,
  JobValidationError,
} from '../utils/errors.js'
import { formatDateToUTC, resolveDelayToDate } from '../utils/date.js'
import { getJobsConfig } from '../utils/jobsConfig.js'
import { getLambdaArn } from '../utils/lambda.js'

export interface CreateScheduleParams {
  id: string
  jobName: string
  jobSource: string
  payload: Record<string, unknown>
  maxRetryAttempts: number
  schedule: ScheduleOptions
  flexibleWindowMinutes?: number
}

export interface CreateRetryScheduleParams {
  id: string
  jobName: string
  jobSource: string
  payload: Record<string, unknown>
  maxRetryAttempts: number
  /** Original occurrence, kept so the lifecycle treats it as the same. */
  scheduledTime: string
  /** ISO instant at which the new attempt must happen. */
  runAt: string
  attempt: number
}

interface AwsConfig {
  region: string
  roleArn: string
  groupName: string
}

const cachedClients = new Map<string, SchedulerClient>()

const createClient = () => {
  const { region, schedulerRoleArn: roleArn, scheduleGroup } = getJobsConfig()

  if (!region || !roleArn) {
    throw new JobConfigError(
      'Incomplete AWS config. Make sure to set: ' +
        'region (AWS_REGION) and schedulerRoleArn (JOB_ROLE_ARN)'
    )
  }

  let client = cachedClients.get(region)
  if (!client) {
    client = new SchedulerClient({ region })
    cachedClients.set(region, client)
  }

  return {
    client,
    awsConfig: { region, roleArn, groupName: scheduleGroup } as AwsConfig,
  }
}

/**
 * Resolves the client on the first call, and not on module import.
 *
 * This allows importing the package in Lambdas that don't create schedules (for example
 * one that only queries jobs) without requiring the full AWS config. The config is read
 * again on every call, because it comes from the entry point that started it.
 */
const getClient = () => createClient()

/**
 * Schedule name accepted by EventBridge, which doesn't allow `#` in the identifier.
 */
export const scheduleName = (jobId: string): string => jobId.replace(/#/g, '-')

/** Name of the schedule of an attempt, derived from the job id. */
export const retryScheduleName = (jobId: string, attempt: number): string =>
  `${scheduleName(jobId)}-r${attempt}`

export const createSchedule = async (
  params: CreateScheduleParams
): Promise<void> => {
  const { client, awsConfig } = getClient()

  await client
    .send(buildCreateCommand(awsConfig.groupName, params, awsConfig))
    .catch((err) => {
      throw new JobSchedulerError(
        `Failed to create schedule ${params.id} in EventBridge`,
        { cause: err }
      )
    })
}

/**
 * Creates the schedule of a new attempt of the same occurrence.
 *
 * The `scheduledTime` in the Input is the one of the original occurrence, and not the
 * firing time: that is what makes the lifecycle treat the delivery as a retry, not as a
 * new occurrence.
 */
export const createRetrySchedule = async (
  params: CreateRetryScheduleParams
): Promise<void> => {
  const { client, awsConfig } = getClient()
  const lambdaArn = getLambdaArn(params.jobName)

  const command = new CreateScheduleCommand({
    GroupName: awsConfig.groupName,
    Name: retryScheduleName(params.id, params.attempt),
    ScheduleExpression: `at(${formatDateToUTC(params.runAt)})`,
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: lambdaArn,
      RoleArn: awsConfig.roleArn,
      Input: buildEventInput(params, {
        // The occurrence is the original one, not the firing time: that is what makes
        // the lifecycle treat the delivery as a retry.
        scheduledTime: params.scheduledTime,
        attempt: params.attempt,
        schedulerExecutionId: SCHEDULER_PLACEHOLDERS.schedulerExecutionId,
      }),
      RetryPolicy: { MaximumRetryAttempts: 0 },
    },
    State: 'ENABLED',
    ActionAfterCompletion: 'DELETE',
  })

  await client.send(command).catch((err) => {
    throw new JobSchedulerError(
      `Failed to schedule attempt ${params.attempt} of job ${params.id}`,
      { cause: err }
    )
  })
}

export const deleteSchedule = async (name: string): Promise<void> => {
  const { client, awsConfig } = getClient()

  await client
    .send(
      new DeleteScheduleCommand({
        GroupName: awsConfig.groupName,
        Name: scheduleName(name),
      })
    )
    .catch((err) => {
      if (err instanceof ResourceNotFoundException) return

      throw new JobSchedulerError(
        `Failed to delete schedule ${name} in EventBridge`,
        { cause: err }
      )
    })
}

/**
 * Values EventBridge replaces at delivery time.
 *
 * `attempt` comes as a string in the rendered JSON and is coerced to number in the event
 * validation.
 */
const SCHEDULER_PLACEHOLDERS = {
  scheduledTime: '<aws.scheduler.scheduled-time>',
  attempt: '<aws.scheduler.attempt-number>',
  schedulerExecutionId: '<aws.scheduler.execution-id>',
} as unknown as Pick<
  JobEvent,
  'scheduledTime' | 'attempt' | 'schedulerExecutionId'
>

/** `JobEvent` fields shared by the occurrence and the retries. */
type JobEventBase = Pick<
  CreateScheduleParams,
  'id' | 'jobName' | 'jobSource' | 'payload' | 'maxRetryAttempts'
>

/**
 * Builds the Lambda `Input`, typed by `JobEvent` so the envelope doesn't diverge between
 * the occurrence and the retries.
 */
const buildEventInput = (
  params: JobEventBase,
  occurrence: Pick<JobEvent, 'scheduledTime' | 'attempt' | 'schedulerExecutionId'>
): string => {
  const input: Record<keyof JobEvent, unknown> = {
    id: params.id,
    name: params.jobName,
    jobSource: params.jobSource,
    payload: params.payload,
    maxRetryAttempts: params.maxRetryAttempts,
    scheduledTime: occurrence.scheduledTime,
    attempt: occurrence.attempt,
    schedulerExecutionId: occurrence.schedulerExecutionId,
  }

  return JSON.stringify(input)
}

const buildScheduleExpression = (schedule: ScheduleOptions): string => {
  if ('at' in schedule) return `at(${formatDateToUTC(schedule.at)})`
  if ('cron' in schedule) return `cron(${schedule.cron})`
  if ('rate' in schedule) return `rate(${schedule.rate.value} ${schedule.rate.unit})`
  if ('delay' in schedule) {
    const futureDate = resolveDelayToDate(schedule.delay)
    return `at(${formatDateToUTC(futureDate)})`
  }
  throw new JobValidationError('ScheduleOptions must contain delay, at, cron or rate')
}

const buildCreateCommand = (
  groupName: string,
  params: CreateScheduleParams,
  config: AwsConfig
) =>
  new CreateScheduleCommand({
    GroupName: groupName,
    Name: scheduleName(params.id),
    ScheduleExpression: buildScheduleExpression(params.schedule),
    FlexibleTimeWindow: params.flexibleWindowMinutes
      ? { Mode: 'FLEXIBLE', MaximumWindowInMinutes: params.flexibleWindowMinutes }
      : { Mode: 'OFF' },
    Target: {
      Arn: getLambdaArn(params.jobName),
      RoleArn: config.roleArn,
      Input: buildEventInput(params, SCHEDULER_PLACEHOLDERS),
      RetryPolicy: { MaximumRetryAttempts: 0 },
    },
    State: 'ENABLED',
    ActionAfterCompletion: 'DELETE',
  })

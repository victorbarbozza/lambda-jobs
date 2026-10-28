import { randomUUID } from 'node:crypto'
import {
  CRON_FIELDS,
  defaultJobDefinition,
  MAX_FLEXIBLE_WINDOW_MINUTES,
  MAX_RETRY_AGE_MINUTES,
  MAX_RETRY_ATTEMPTS,
  MIN_RETRY_DELAY_SECONDS,
  RECURRING_FIRST_DEADLINE_MS,
} from '../config.js'
import * as scheduler from '../connectors/eventBridgeScheduler.js'
import * as db from '../db/entities.js'
import type {
  Job,
  JobDefinition,
  JobDefinitions,
  JobInput,
  JobName,
} from '../types/job.js'
import type { ScheduleOptions } from '../types/schedule.js'
import { isPastDate, isValidDate, resolveDelayToDate, utcNow } from '../utils/date.js'
import { JobValidationError } from '../utils/errors.js'
import { isTerminal, nextAttempt } from '../utils/job.js'
import { deadlineFor, deliveryTolerance } from './deadline.js'

/** Job definition with the defaults applied. */
type ResolvedJobDefinition = typeof defaultJobDefinition & JobDefinition

/**
 * Stores a job and schedules its execution in EventBridge Scheduler.
 *
 * Writes the job, its source relation and the deadline of the first delivery in one
 * transaction, and only then creates the schedule. If scheduling fails, the job is
 * deleted before the error is propagated.
 */
export const createJob = async <T extends JobDefinitions>(
  name: JobName<T>,
  jobSource: string,
  payload: Record<string, unknown>,
  schedule: ScheduleOptions | undefined,
  jobDefinitions: T
): Promise<string> => {
  const definition: ResolvedJobDefinition = {
    ...defaultJobDefinition,
    ...jobDefinitions[name],
  }

  validateJobDefinition(definition, name)

  const {
    maxRetryAttempts,
    flexibleWindowMinutes,
    retryMaxAgeMinutes,
    failureStrategy,
  } = definition

  const id = `${name}#${randomUUID()}`
  const resolvedSchedule = schedule ?? definition.schedule
  validateSchedule(resolvedSchedule)

  const job: JobInput = {
    id,
    name,
    jobSource,
    payload,
    schedule: resolvedSchedule,
    maxRetryAttempts,
    failureStrategy,
    flexibleWindowMinutes,
    retryMaxAgeMinutes,
    status: 'scheduled',
    nextDeadline: firstDeadline(resolvedSchedule, definition),
  }

  await db.createJob(job)

  try {
    await scheduler.createSchedule({
      id,
      jobName: name,
      jobSource,
      payload,
      maxRetryAttempts,
      schedule: resolvedSchedule,
      flexibleWindowMinutes,
    })
  } catch (err) {
    await db.deleteJob(job.id, job.jobSource, job.nextDeadline)
    throw err
  }

  return id
}

/** Deadline of the first delivery, derived from the schedule time. */
const firstDeadline = (
  schedule: ScheduleOptions,
  definition: JobDefinition
): string => {
  const expectedAt =
    'at' in schedule
      ? new Date(schedule.at).getTime()
      : 'delay' in schedule
        ? new Date(resolveDelayToDate(schedule.delay)).getTime()
        : utcNow() + RECURRING_FIRST_DEADLINE_MS

  return deadlineFor(
    expectedAt,
    deliveryTolerance(
      definition.deadlineToleranceSeconds,
      definition.flexibleWindowMinutes
    )
  )
}

/**
 * Cancels an existing job and removes its schedule, pending retry and deadline.
 *
 * Returns `false` when the job was already terminal or no longer exists. Even then, the
 * schedule is removed to clean up orphans in EventBridge.
 */
export const cancelJob = async (id: string): Promise<boolean> => {
  const job = await db.getJobById(id)

  if (!job) {
    await scheduler.deleteSchedule(id)
    return false
  }

  if (isTerminal(job.status)) return false

  await db.moveDeadline(id, job.nextDeadline, undefined, {
    status: 'cancelled',
    nextRetryAt: undefined,
  })

  await scheduler.deleteSchedule(id)
  await deletePendingRetry(job)

  return true
}

/** Removes the schedule of the pending attempt, when there is one. */
const deletePendingRetry = async (job: Job): Promise<void> => {
  if (!job.nextRetryAt) return

  const attempt = await nextAttemptFor(job.id, job.lastScheduledTime ?? '')

  await scheduler.deleteSchedule(scheduler.retryScheduleName(job.id, attempt))
}

/** Number the next attempt of the occurrence will get. */
const nextAttemptFor = async (
  jobId: string,
  scheduledTime: string
): Promise<number> =>
  nextAttempt(await db.getOccurrenceExecutions(jobId, scheduledTime))

/**
 * Schedules a new attempt for now, ignoring the configured backoff.
 *
 * Returns `false` when the job is already terminal or does not exist.
 */
export const retryNow = async (id: string): Promise<boolean> => {
  const job = await db.getJobById(id)

  if (!job || isTerminal(job.status)) return false

  const scheduledTime = job.lastScheduledTime ?? new Date(utcNow()).toISOString()
  const attempt = await nextAttemptFor(id, scheduledTime)
  const runAt = new Date(utcNow() + MIN_RETRY_DELAY_SECONDS * 1000).toISOString()

  await scheduler.createRetrySchedule({
    id,
    jobName: job.name,
    jobSource: job.jobSource,
    payload: job.payload,
    maxRetryAttempts: job.maxRetryAttempts,
    scheduledTime,
    runAt,
    attempt,
  })

  await db.moveDeadline(id, job.nextDeadline, deadlineFor(new Date(runAt).getTime()), {
    nextRetryAt: runAt,
  })

  return true
}

/** Validates the local rules of `ScheduleOptions` before sending it to the scheduler. */
const validateSchedule = (schedule: ScheduleOptions): void => {
  if ('rate' in schedule && schedule.rate.value <= 0) {
    throw new JobValidationError('rate.value must be greater than 0')
  }
  if ('delay' in schedule && schedule.delay.value <= 0) {
    throw new JobValidationError('delay.value must be greater than 0')
  }
  if ('at' in schedule) {
    validateFutureDate(schedule.at, 'at')
  }
  if ('cron' in schedule) {
    validateCron(schedule.cron)
  }
  if ('endDate' in schedule && schedule.endDate != null) {
    validateFutureDate(schedule.endDate, 'endDate')
  }
}

/** Rejects invalid or past dates, which would create a schedule that never runs. */
const validateFutureDate = (date: string, field: string): void => {
  if (!isValidDate(date)) {
    throw new JobValidationError(`${field} is not a valid date. Received: ${date}`)
  }
  if (isPastDate(date)) {
    throw new JobValidationError(`${field} must be a future date. Received: ${date}`)
  }
}

/** EventBridge Scheduler uses 6-field cron expressions, not the 5 fields of Unix cron. */
const validateCron = (cron: string): void => {
  const fields = cron.trim().split(/\s+/)

  if (fields.length !== CRON_FIELDS) {
    throw new JobValidationError(
      `cron must have ${CRON_FIELDS} fields (minutes hours day-of-month month day-of-week year). ` +
        `Received: "${cron}"`
    )
  }
}

/** Numeric fields with a fixed range, validated the same way. */
const NUMERIC_RANGES = [
  { field: 'maxRetryAttempts', min: 0, max: MAX_RETRY_ATTEMPTS },
  { field: 'retryMaxAgeMinutes', min: 1, max: MAX_RETRY_AGE_MINUTES },
  { field: 'flexibleWindowMinutes', min: 0, max: MAX_FLEXIBLE_WINDOW_MINUTES },
] as const

/** Validates the static job definition against the limits the library accepts. */
const validateJobDefinition = (
  definition: ResolvedJobDefinition,
  name: string
): void => {
  if (!name) throw new JobValidationError('job name is required')

  for (const { field, min, max } of NUMERIC_RANGES) {
    const value = definition[field]

    if (value < min || value > max) {
      throw new JobValidationError(
        `${field} must be between ${min} and ${max}. Received: ${value}`
      )
    }
  }

  validateRetryDelay(definition)
  validateExecutionRetention(definition)
}

/** A backoff longer than the occurrence window would make the retry never happen. */
const validateRetryDelay = (definition: ResolvedJobDefinition): void => {
  const firstDelay = definition.retryDelay?.(2)
  if (firstDelay == null) return

  if (!(firstDelay > 0)) {
    throw new JobValidationError(
      `retryDelay must return a number greater than 0. Received: ${firstDelay}`
    )
  }

  if (firstDelay > definition.retryMaxAgeMinutes * 60) {
    throw new JobValidationError(
      `retryDelay of the first retry (${firstDelay}s) exceeds retryMaxAgeMinutes ` +
        `(${definition.retryMaxAgeMinutes}min): no retry would ever happen`
    )
  }
}

/**
 * The history cannot expire before the occurrence ends: the attempt number and the
 * detection of abandoned invocations come from it.
 */
const validateExecutionRetention = (definition: ResolvedJobDefinition): void => {
  const { executionRetentionDays, retryMaxAgeMinutes } = definition
  if (executionRetentionDays == null) return

  if (!(executionRetentionDays > 0)) {
    throw new JobValidationError(
      `executionRetentionDays must be greater than 0. Received: ${executionRetentionDays}`
    )
  }

  if (executionRetentionDays * 24 * 60 < retryMaxAgeMinutes) {
    throw new JobValidationError(
      `executionRetentionDays (${executionRetentionDays}d) is shorter than retryMaxAgeMinutes ` +
        `(${retryMaxAgeMinutes}min): the history would expire before the occurrence ends`
    )
  }
}

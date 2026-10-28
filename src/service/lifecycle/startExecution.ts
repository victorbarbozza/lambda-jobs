import * as db from '../../db/entities.js'
import type { JobEvent } from '../../types/event.js'
import type { ExecutionPolicy, Job, JobExecution } from '../../types/job.js'
import { utcNow } from '../../utils/date.js'
import {
  JobError,
  JobSkippedError,
  JobTerminalStateError,
} from '../../utils/errors.js'
import { isTerminal, nextAttempt } from '../../utils/job.js'
import { isExpired, isRecurring } from '../../utils/schedule.js'
import { deadlineFor } from '../deadline.js'
import {
  closeJob,
  markAttemptAbandoned,
  type ExecutionContext,
} from './shared.js'

/**
 * Opens the attempt of an occurrence and returns the context used by the following
 * phases.
 *
 * Telling a new occurrence from a retry comes from the executions already recorded for
 * that `scheduledTime`, not from the job's `lastScheduledTime`: on a recurring job, a
 * late retry may arrive after the next occurrence has started.
 */
export const startExecution = async (
  event: JobEvent,
  lambdaTimeoutMs: number,
  policy?: ExecutionPolicy
): Promise<ExecutionContext> => {
  const jobEntity = await getJobOrThrow(event.id)

  const attempts = await db.getOccurrenceExecutions(event.id, event.scheduledTime)

  ensureOccurrenceNotCompleted(event.id, event.scheduledTime, attempts)

  const latestAttempt = attempts[attempts.length - 1] ?? null
  ensureNoAttemptRunning(event.id, latestAttempt)

  if (latestAttempt?.status === 'running') {
    await markAttemptAbandoned(event.id, latestAttempt)
  }

  const isNewExecution = attempts.length === 0
  if (isNewExecution && isExpired(jobEntity.schedule)) {
    await closeJob(event.id, 'completed', jobEntity.nextDeadline)
    throw new JobTerminalStateError(`Job ${event.id} expired (endDate reached)`, {
      reason: 'expired',
    })
  }

  const attempt = nextAttempt(attempts)
  const execution = buildExecution(
    event,
    attempt,
    lambdaTimeoutMs,
    latestAttempt?.ttl ?? executionTtl(policy?.executionRetentionDays)
  )
  const deadline = deadlineFor(
    execution.expiresAt,
    policy?.deadlineToleranceSeconds
  )

  await db.upsertExecution(event.id, execution)
  await db.moveDeadline(
    event.id,
    jobEntity.nextDeadline,
    deadline,
    jobFieldsForAttempt(event, jobEntity, isNewExecution)
  )

  return { execution, jobEntity, isNewExecution, attempt, deadline }
}

/** Loads the job and blocks the execution when it does not exist or is already terminal. */
const getJobOrThrow = async (jobId: string): Promise<Job> => {
  const jobEntity = await db.getJobById(jobId)

  if (!jobEntity) {
    throw new JobError(`Job ${jobId} not found`)
  }

  if (isTerminal(jobEntity.status)) {
    throw new JobTerminalStateError(
      `Job ${jobId} cannot run (status: ${jobEntity.status})`,
      { reason: jobEntity.status === 'cancelled' ? 'cancelled' : 'completed' }
    )
  }

  return jobEntity
}

/** Does not run the occurrence again if a previous attempt already succeeded. */
const ensureOccurrenceNotCompleted = (
  jobId: string,
  scheduledTime: string,
  attempts: JobExecution[]
): void => {
  if (attempts.some((attempt) => attempt.status === 'completed')) {
    throw new JobTerminalStateError(
      `Job ${jobId} already succeeded for ${scheduledTime}`,
      { reason: 'already_completed_for_scheduled_time' }
    )
  }
}

/**
 * Blocks when the previous attempt is still `running` within its own deadline.
 *
 * The deadline comes from the `expiresAt` written by the attempt itself, because no event
 * metadata tells one delivery from another: the Scheduler renders the Input once and
 * repeats the same payload on every redelivery.
 */
const ensureNoAttemptRunning = (
  jobId: string,
  latestAttempt: JobExecution | null
): void => {
  if (latestAttempt?.status !== 'running') return

  if (utcNow() <= latestAttempt.expiresAt) {
    throw new JobSkippedError(`Job ${jobId} is already running`)
  }
}

const jobFieldsForAttempt = (
  event: JobEvent,
  jobEntity: Job,
  isNewExecution: boolean
): Partial<Job> => {
  const fields: Partial<Job> = { nextRetryAt: undefined }

  if (!isNewExecution) return fields

  fields.lastScheduledTime = event.scheduledTime
  if (isRecurring(jobEntity.schedule)) fields.status = 'active'

  return fields
}

/**
 * Expiration instant of the record, in seconds, or `undefined` to never expire.
 *
 * The attempts of an occurrence inherit the `ttl` of the first one, so the occurrence
 * disappears whole instead of losing its first attempts before the last ones.
 */
const executionTtl = (retentionDays?: number): number | undefined =>
  retentionDays
    ? Math.floor(utcNow() / 1000) + retentionDays * 24 * 60 * 60
    : undefined

const buildExecution = (
  event: JobEvent,
  attempt: number,
  lambdaTimeoutMs: number,
  ttl?: number
): JobExecution => ({
  scheduledTime: event.scheduledTime,
  status: 'running',
  attempt,
  startedAt: utcNow(),
  expiresAt: utcNow() + lambdaTimeoutMs,
  schedulerExecutionId: event.schedulerExecutionId,
  ...(ttl ? { ttl } : {}),
})

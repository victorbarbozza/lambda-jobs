import { createRetrySchedule } from '../../connectors/eventBridgeScheduler.js'
import * as db from '../../db/entities.js'
import type { JobEvent } from '../../types/event.js'
import type { ExecutionPolicy } from '../../types/job.js'
import { utcNow } from '../../utils/date.js'
import { toErrorRecords } from '../../utils/job.js'
import { isOnce } from '../../utils/schedule.js'
import { cancelJob } from '../commands.js'
import {
  deadlineFor,
  defaultRetryDelay,
  nextOccurrenceDeadline,
} from '../deadline.js'
import {
  closeJob,
  type ExecutionContext,
  type ExecutionErrorResult,
  type HandlerIntent,
} from './shared.js'

/**
 * Records the failure of the attempt and decides between scheduling the next one or
 * giving up.
 *
 * While there is an attempt left within the occurrence window, creates a new schedule for
 * `now + backoff`. Once exhausted, applies the `failureStrategy` and returns the failures
 * of that occurrence.
 */
export const failExecution = async (
  event: JobEvent,
  error: Error,
  ctx: ExecutionContext,
  policy?: ExecutionPolicy,
  intent?: HandlerIntent
): Promise<ExecutionErrorResult> => {
  await db.upsertExecution(event.id, {
    ...ctx.execution,
    status: 'failed',
    completedAt: utcNow(),
    error: {
      message: error.message,
      code: (error as { code?: string }).code,
      stack: error.stack,
    },
  })

  const runAt = resolveRetryInstant(event, ctx, policy, intent)

  if (runAt) {
    await scheduleRetry(event, ctx, runAt, policy)
    return { outcome: 'retry', runAt }
  }

  await applyFailureStrategy(event.id, ctx, policy)

  const attempts = await db.getOccurrenceExecutions(event.id, event.scheduledTime)

  return { outcome: 'exhausted', errors: toErrorRecords(event.id, attempts) }
}

/** Instant of the next attempt, or `undefined` when the occurrence is exhausted. */
const resolveRetryInstant = (
  event: JobEvent,
  ctx: ExecutionContext,
  policy?: ExecutionPolicy,
  intent?: HandlerIntent
): string | undefined => {
  // Giving up beats the attempt limit: the handler already knows that insisting will
  // not help.
  if (intent?.giveUp) return undefined
  if (ctx.attempt > event.maxRetryAttempts) return undefined

  const delaySeconds =
    intent?.retryInSeconds ??
    policy?.retryDelay?.(ctx.attempt + 1) ??
    defaultRetryDelay(ctx.attempt + 1)

  const runAt = utcNow() + delaySeconds * 1000

  // The wrapper option wins when given; otherwise the policy stored on the job applies.
  const maxAgeMinutes =
    policy?.retryMaxAgeMinutes ?? ctx.jobEntity.retryMaxAgeMinutes

  if (maxAgeMinutes) {
    const occurrenceStart = new Date(event.scheduledTime).getTime()
    const expiresAt = occurrenceStart + maxAgeMinutes * 60 * 1000

    if (Number.isFinite(expiresAt) && runAt > expiresAt) return undefined
  }

  return new Date(runAt).toISOString()
}

const scheduleRetry = async (
  event: JobEvent,
  ctx: ExecutionContext,
  runAt: string,
  policy?: ExecutionPolicy
): Promise<void> => {
  await createRetrySchedule({
    id: event.id,
    jobName: event.name,
    jobSource: event.jobSource,
    payload: event.payload as Record<string, unknown>,
    maxRetryAttempts: event.maxRetryAttempts,
    scheduledTime: event.scheduledTime,
    runAt,
    attempt: ctx.attempt + 1,
  })

  await db.moveDeadline(
    event.id,
    ctx.deadline,
    deadlineFor(new Date(runAt).getTime(), policy?.deadlineToleranceSeconds),
    { nextRetryAt: runAt }
  )
}

/**
 * Applies the terminal strategy of the job when no attempts are left.
 *
 * A recurring job is not closed: the current occurrence dies, but the deadline now
 * points to the next one, keeping the job under the watchdog's watch.
 */
const applyFailureStrategy = async (
  jobId: string,
  ctx: ExecutionContext,
  policy?: ExecutionPolicy
): Promise<void> => {
  if (ctx.jobEntity.failureStrategy.action === 'cancel') {
    await cancelJob(jobId)
    return
  }

  if (isOnce(ctx.jobEntity.schedule)) {
    await closeJob(jobId, 'failed', ctx.deadline)
    return
  }

  await db.moveDeadline(
    jobId,
    ctx.deadline,
    await nextOccurrenceDeadline(ctx.jobEntity, policy?.deadlineToleranceSeconds),
    { nextRetryAt: undefined }
  )
}

import { deleteSchedule } from '../../connectors/eventBridgeScheduler.js'
import * as db from '../../db/entities.js'
import type { Job, JobErrorRecord, JobExecution } from '../../types/job.js'
import { utcNow } from '../../utils/date.js'
import { ABANDONED_ATTEMPT_ERROR } from '../../utils/job.js'

/** What the handler asked for during the execution, through the control context. */
export interface HandlerIntent {
  /** Wait until the next attempt asked by `ctx.retryIn`, in seconds. */
  retryInSeconds?: number
  /** `ctx.giveUp`: the handler knows that insisting will not help. */
  giveUp?: boolean
}

/** State decided in `startExecution` and consumed by the following phases. */
export interface ExecutionContext {
  execution: JobExecution
  jobEntity: Job
  /** First attempt of this occurrence. */
  isNewExecution: boolean
  attempt: number
  /** Deadline written by this attempt, and key of the relation the watchdog queries. */
  deadline: string
}

/** Outcome of a failed attempt. */
export type ExecutionErrorResult =
  | { outcome: 'retry'; runAt: string }
  | { outcome: 'exhausted'; errors: JobErrorRecord[] }

/** Closes the job, removes the schedule and clears the pending deadline. */
export const closeJob = async (
  jobId: string,
  status: Extract<Job['status'], 'completed' | 'failed'>,
  deadline?: string
): Promise<void> => {
  await db.moveDeadline(jobId, deadline, undefined, {
    status,
    completedAt: utcNow(),
    nextRetryAt: undefined,
  })
  await deleteSchedule(jobId)
}

/** Closes as failed the attempt whose invocation died without recording an outcome. */
export const markAttemptAbandoned = async (
  jobId: string,
  attempt: JobExecution
): Promise<void> => {
  await db.upsertExecution(jobId, {
    ...attempt,
    status: 'failed',
    completedAt: utcNow(),
    error: { ...ABANDONED_ATTEMPT_ERROR },
  })
}

/** Closes the attempt as completed and closes the job, regardless of recurrence. */
export const finishJob = async (
  jobId: string,
  ctx: ExecutionContext
): Promise<void> => {
  await db.upsertExecution(jobId, {
    ...ctx.execution,
    status: 'completed',
    completedAt: utcNow(),
  })

  await closeJob(jobId, 'completed', ctx.deadline)
}
